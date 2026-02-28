// ==UserScript==
// @name         WNACG 批量下载器
// @namespace    http://tampermonkey.net/
// @version      0.4.5
// @description  为 WNACG 多镜像站点提供书架、相册和画廊页批量下载功能（含系列作品提示）
// @license      MIT
// @author       Auto Generated
// @match        *://wnacg.com/*
// @match        *://www.wnacg.com/*
// @match        *://wnacg.ru/*
// @match        *://www.wnacg.ru/*
// @match        *://wn01.cfd/*
// @match        *://www.wn01.cfd/*
// @match        *://wn01.shop/*
// @match        *://www.wn01.shop/*
// @match        *://wn07.ru/*
// @match        *://www.wn07.ru/*
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_addStyle
// @connect      wnacg.com
// @connect      wnacg.ru
// @connect      wn01.cfd
// @connect      wn01.shop
// @connect      wn07.ru
// @connect      dl1.wn01.download
// @connect      e-hentai.org
// @connect      www.dlsite.com
// @connect      dlsite.com
// @run-at       document-end
// ==/UserScript==

(function() {
  'use strict';

  // ============ 全局配置 ============
  const CONFIG = {
    // 脚本版本
    VERSION: '0.4.5',
    // 页面类型常量
    PAGE_TYPE: {
      SHELF: 'shelf',      // 书架页
      ALBUM: 'album',      // 相册页
      GALLERY: 'gallery'   // 画廊页（首页/更新/分类/排行/搜索）
    },
    // 下载配置
    DOWNLOAD: {
      TIMEOUT: 30000,      // 单个请求超时时间（毫秒）
      RETRY_COUNT: 3       // 失败重试次数
    }
  };

  // ============ 全局状态 ============
  const STATE = {
    currentPageType: null,
    isInitialized: false,
    activeQueue: null,
    selectMode: false,
    galleryPopularity: {
      running: false,
      queued: false
    },
    ui: {
      progressPanel: null,
      progressFill: null,
      progressText: null,
      logBox: null,
      pauseBtn: null,
      clearQueueBtn: null,
      minimized: false,
      galleryAutoBtn: null
    }
  };

  // ============ 选择持久化（sessionStorage） ============
  const STORAGE_KEY = 'wnacg_bd_selected_aids';
  const MODE_STORAGE_KEY = 'wnacg_bd_select_mode';
  const POPULARITY_CACHE_KEY = 'wnacg_bd_popularity_cache_v1';
  const POPULARITY_HISTORY_KEY = 'wnacg_bd_popularity_history_v1';
  const POPULARITY_REMOTE_CACHE_KEY = 'wnacg_bd_popularity_remote_cache_v1';
  const GALLERY_POPULARITY_AUTO_KEY = 'wnacg_bd_gallery_popularity_auto';
  const GALLERY_RANK_LOOKUP_CACHE_KEY = 'wnacg_bd_gallery_rank_lookup_cache_v1';

  function getStoredAids() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }

  function setStoredAids(aids) {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(aids));
  }

  function addStoredAid(aid) {
    const aids = getStoredAids();
    if (!aids.includes(aid)) { aids.push(aid); setStoredAids(aids); }
  }

  function removeStoredAid(aid) {
    setStoredAids(getStoredAids().filter(a => a !== aid));
  }

  function isAidStored(aid) {
    return getStoredAids().includes(aid);
  }

  function clearStoredAids() {
    sessionStorage.removeItem(STORAGE_KEY);
  }

  function getStoredSelectMode() {
    try {
      return sessionStorage.getItem(MODE_STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  }

  function setStoredSelectMode(enabled) {
    try {
      if (enabled) {
        sessionStorage.setItem(MODE_STORAGE_KEY, '1');
      } else {
        sessionStorage.removeItem(MODE_STORAGE_KEY);
      }
    } catch {}
  }

  // ============ 移动端检测 ============
  const IS_NARROW = window.matchMedia?.('(max-width: 768px)').matches ?? false;
  const IS_TOUCH = 'ontouchstart' in window || (navigator.maxTouchPoints || 0) > 0;
  const IS_MOBILE = IS_NARROW && IS_TOUCH;

  // 响应式：监听 media query 变化（平板旋转/分屏）
  let isMobileUI = IS_NARROW;
  const mql = window.matchMedia?.('(max-width: 768px)');
  if (mql && mql.addEventListener) {
    mql.addEventListener('change', (e) => {
      isMobileUI = e.matches;
    });
  }
  // ============ 工具函数 ============
  
  /**
   * 判断当前页面类型
   * @returns {string|null} 页面类型（'shelf'、'album'、'gallery'）或 null
   */
  function detectPageType() {
    const href = String(location.href || '').toLowerCase();
    const path = String(location.pathname || '').toLowerCase();

    if (href.includes('users-users_fav') || href.includes('/users/users_fav')) {
      return CONFIG.PAGE_TYPE.SHELF;
    }

    // 相册详情兼容：网页版 photos-index / 移动阅读页 photos-slist/photos-slide
    if (/photos-(?:index|slist|slide)-aid-\d+(?:\.html)?/i.test(href)) {
      return CONFIG.PAGE_TYPE.ALBUM;
    }

    // 画廊页：首页、更新/分类/排行、搜索（兼容静态路由和 /search/index.php）
    if (path === '/' || path === '/index.html') {
      return CONFIG.PAGE_TYPE.GALLERY;
    }
    if (/^\/albums(?:-[^/]+)?\.html$/.test(path)) {
      return CONFIG.PAGE_TYPE.GALLERY;
    }
    if (/^\/search(?:-[^/]+)?\.html$/.test(path)) {
      return CONFIG.PAGE_TYPE.GALLERY;
    }
    if (path.startsWith('/search/') || path === '/search/index.php') {
      return CONFIG.PAGE_TYPE.GALLERY;
    }

    // URL 无法命中时做一次 DOM 兜底，避免不同模板失配
    if (document.querySelector('a[href*="photos-index-aid-"], a[href*="photos-slist-aid-"], a[href*="photos-slide-aid-"]')) {
      return CONFIG.PAGE_TYPE.GALLERY;
    }

    return null;
  }

  /**
   * 日志输出
   * @param {string} message 日志消息
   * @param {string} level 日志级别 ('info', 'warn', 'error')
   */
  function log(message, level = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    const prefix = `[WNACG-Downloader ${CONFIG.VERSION}]`;
    
    switch (level) {
      case 'warn':
        console.warn(`${prefix} [${timestamp}] ⚠️  ${message}`);
        break;
      case 'error':
        console.error(`${prefix} [${timestamp}] ❌ ${message}`);
        break;
      case 'info':
      default:
        console.log(`${prefix} [${timestamp}] ℹ️  ${message}`);
    }
  }

  /**
   * 注入样式
   * @param {string} css CSS 样式代码
   */
  function injectStyles(css) {
    try {
      GM_addStyle(css);
      log('样式注入成功');
    } catch (error) {
      log(`样式注入失败: ${error.message}`, 'error');
    }
  }

  /**
   * 页面通用基础样式
   */
  function injectBaseStyles() {
    const baseCSS = `
      /* WNACG Batch Downloader 样式 */
      .wnacg-batch-btn {
        padding: 8px 16px;
        margin: 5px;
        border: none;
        border-radius: 4px;
        background-color: #4CAF50;
        color: white;
        font-size: 14px;
        cursor: pointer;
        transition: background-color 0.3s ease;
      }
      
      .wnacg-batch-btn:hover {
        background-color: #45a049;
      }
      
      .wnacg-batch-btn:disabled {
        background-color: #cccccc;
        cursor: not-allowed;
      }

      .wnacg-album-oneclick-btn {
        margin-left: 8px;
        vertical-align: middle;
      }

      .wnacg-album-oneclick-btn.wnacg-disabled {
        opacity: 0.6;
        pointer-events: none;
      }

      .wnacg-album-series-btn {
        margin-left: 8px;
        vertical-align: middle;
      }

      .wnacg-series-panel {
        margin: 12px 0 8px;
        padding: 10px 12px;
        border: 1px solid #d9d9d9;
        border-radius: 8px;
        background: #fff;
      }

      .wnacg-series-title {
        font-size: 14px;
        font-weight: 600;
        color: #333;
        margin-bottom: 8px;
      }

      .wnacg-series-keyword {
        color: #2e7d32;
        margin-left: 6px;
        font-weight: 500;
      }

      .wnacg-series-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      .wnacg-series-loading {
        font-size: 12px;
        color: #666;
      }

      .wnacg-series-list a {
        color: #1565c0;
        text-decoration: none;
        line-height: 1.35;
      }

      .wnacg-series-list a:hover {
        text-decoration: underline;
      }

      .wnacg-popularity-panel {
        margin: 10px 0 8px;
        padding: 10px 12px;
        border: 1px solid #d9e3ea;
        border-radius: 8px;
        background: #fbfefe;
      }

      .wnacg-popularity-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 6px;
      }

      .wnacg-popularity-title {
        font-size: 14px;
        font-weight: 600;
        color: #274c5a;
      }

      .wnacg-popularity-main {
        font-size: 15px;
        font-weight: 700;
        color: #0f766e;
      }

      .wnacg-popularity-main.wnacg-hot-s {
        color: #b45309;
      }

      .wnacg-popularity-main.wnacg-hot-a {
        color: #15803d;
      }

      .wnacg-popularity-main.wnacg-hot-b {
        color: #0f766e;
      }

      .wnacg-popularity-main.wnacg-hot-c {
        color: #1d4ed8;
      }

      .wnacg-popularity-main.wnacg-hot-d {
        color: #6b7280;
      }

      .wnacg-popularity-meta {
        margin-top: 6px;
        font-size: 12px;
        color: #4b6270;
        line-height: 1.5;
      }

      .wnacg-popularity-help {
        margin-top: 4px;
        font-size: 12px;
        color: #5f7380;
        line-height: 1.4;
      }

      .wnacg-popularity-trend-up {
        color: #b91c1c;
      }

      .wnacg-popularity-trend-down {
        color: #1d4ed8;
      }

      .wnacg-popularity-trend-flat {
        color: #4b5563;
      }

      .wnacg-popularity-refresh {
        padding: 4px 10px;
        border: 1px solid #bfd7df;
        border-radius: 999px;
        background: #fff;
        color: #285d71;
        font-size: 12px;
        line-height: 1.2;
        cursor: pointer;
      }

      .wnacg-popularity-refresh:disabled {
        opacity: 0.65;
        cursor: not-allowed;
      }
      
      .wnacg-progress-panel {
        position: fixed;
        bottom: 20px;
        right: 20px;
        width: 350px;
        background-color: #f5f5f5;
        border: 1px solid #ddd;
        border-radius: 8px;
        padding: 16px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.15);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
        z-index: 9999;
      }
      
      .wnacg-progress-title {
        font-size: 16px;
        font-weight: bold;
        margin-bottom: 12px;
        color: #333;
      }
      
      .wnacg-progress-bar {
        width: 100%;
        height: 8px;
        background-color: #e0e0e0;
        border-radius: 4px;
        overflow: hidden;
        margin-bottom: 8px;
      }
      
      .wnacg-progress-fill {
        height: 100%;
        background-color: #4CAF50;
        transition: width 0.3s ease;
      }
      
       .wnacg-progress-text {
         font-size: 12px;
         color: #666;
         margin-bottom: 12px;
       }

       .wnacg-shelf-toolbar {
         display: flex;
         flex-wrap: wrap;
         align-items: center;
         gap: 8px;
         padding: 10px;
         margin: 10px 0;
         border: 1px solid #ddd;
         border-radius: 8px;
         background: #fff;
       }

       .wnacg-shelf-toolbar label {
         display: inline-flex;
         align-items: center;
         gap: 6px;
         font-size: 12px;
         color: #333;
         user-select: none;
       }

       .wnacg-shelf-checkbox {
         margin-right: 8px;
         vertical-align: middle;
       }

       .wnacg-shelf-count {
         margin-left: auto;
         font-size: 12px;
         color: #666;
       }

       .wnacg-progress-log {
         max-height: 180px;
         overflow: auto;
         padding: 8px;
         border: 1px solid #ddd;
         border-radius: 6px;
         background: #fff;
         font-size: 12px;
         line-height: 1.4;
         color: #333;
       }

       .wnacg-progress-actions {
         display: flex;
         gap: 8px;
         margin-top: 10px;
       }

       .wnacg-progress-actions button {
          flex: 1;
        }

        .wnacg-gallery-toolbar {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 8px;
          padding: 10px 15px;
          margin: 10px auto;
          max-width: 1200px;
          border: 1px solid #ddd;
          border-radius: 8px;
          background: #fff;
          box-shadow: 0 1px 4px rgba(0,0,0,0.08);
          z-index: 100;
          position: relative;
        }

        .wnacg-gallery-toolbar .wnacg-batch-btn {
          padding: 6px 14px;
          font-size: 13px;
        }

        .wnacg-gallery-count {
          margin-left: auto;
          font-size: 12px;
          color: #666;
        }

        .wnacg-gallery-hot-legend {
          flex: 1 1 100%;
          font-size: 12px;
          line-height: 1.4;
          color: #5f7380;
        }

        .wnacg-gallery-checkbox {
          position: absolute;
          top: 6px;
          left: 6px;
          width: 18px;
          height: 18px;
          cursor: pointer;
          z-index: 10;
          accent-color: #4CAF50;
        }

        .wnacg-gallery-hot-badge {
          position: absolute;
          right: 6px;
          bottom: 6px;
          z-index: 11;
          padding: 2px 7px;
          border-radius: 999px;
          font-size: 11px;
          font-weight: 700;
          line-height: 1.3;
          color: #fff;
          background: rgba(17, 24, 39, 0.78);
          pointer-events: auto;
          cursor: default;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
          white-space: nowrap;
        }

        .wnacg-gallery-hot-badge.wnacg-hot-s { background: #b45309; }
        .wnacg-gallery-hot-badge.wnacg-hot-a { background: #15803d; }
        .wnacg-gallery-hot-badge.wnacg-hot-b { background: #0f766e; }
        .wnacg-gallery-hot-badge.wnacg-hot-c { background: #1d4ed8; }
        .wnacg-gallery-hot-badge.wnacg-hot-d { background: #4b5563; }
        .wnacg-gallery-hot-badge.wnacg-hot-loading { background: #7c3aed; }

         li.gallary_item,
         .wnacg-gallery-item {
           position: relative;
         }

         /* 选择模式下的卡片选中标记 */
         li.gallary_item.wnacg-selected .pic_box::after,
         .wnacg-gallery-item.wnacg-selected .pic_box::after {
           content: '✓';
           position: absolute;
           top: 0; left: 0; right: 0; bottom: 0;
           background: rgba(76, 175, 80, 0.35);
           display: flex;
           align-items: center;
           justify-content: center;
           font-size: 48px;
           color: #fff;
           text-shadow: 0 2px 6px rgba(0,0,0,0.4);
           pointer-events: none;
           z-index: 5;
         }

         .wnacg-gallery-item.wnacg-selected::after {
           content: '✓';
           position: absolute;
           top: 0; left: 0; right: 0; bottom: 0;
           background: rgba(76, 175, 80, 0.28);
           display: flex;
           align-items: center;
           justify-content: center;
           font-size: 40px;
           color: #fff;
           text-shadow: 0 2px 6px rgba(0,0,0,0.4);
           pointer-events: none;
           z-index: 4;
         }

         li.gallary_item .pic_box,
         .wnacg-gallery-item .pic_box {
           position: relative;
           z-index: 6;
         }

         /* 选择模式按钮激活状态 */
         .wnacg-batch-btn.wnacg-select-mode-active {
           background: #4CAF50;
           color: #fff;
           border-color: #4CAF50;
         }

          /* 选择模式下封面的 cursor */
          body.wnacg-select-mode li.gallary_item .pic_box,
          body.wnacg-select-mode .wnacg-gallery-item .pic_box {
            cursor: pointer;
          }

          .wnacg-gallery-mode-indicator {
            padding: 4px 10px;
            border-radius: 999px;
            border: 1px solid #d6d6d6;
            background: #f6f6f6;
            color: #666;
            font-size: 12px;
            white-space: nowrap;
          }

          .wnacg-gallery-mode-indicator.wnacg-active {
            border-color: #2e7d32;
            background: #e8f5e9;
            color: #1b5e20;
            font-weight: 600;
          }

          .wnacg-batch-btn.wnacg-exit-mode-btn {
            background: #f44336;
          }

          .wnacg-batch-btn.wnacg-exit-mode-btn:hover {
            background: #e53935;
          }

          /* ============ 移动端适配 ============ */
          @media (max-width: 768px) {
            :root {
              --wnacg-toolbar-h: 72px;
              --wnacg-sa-bottom: env(safe-area-inset-bottom, 0px);
            }

            /* 画廊工具栏底部悬浮 */
            .wnacg-gallery-toolbar {
              position: fixed;
              left: 0; right: 0;
              bottom: env(safe-area-inset-bottom, 0px);
              margin: 0;
              max-width: none;
              border-radius: 12px 12px 0 0;
              padding: 8px 10px;
              overflow-x: auto;
              -webkit-overflow-scrolling: touch;
              flex-wrap: nowrap;
              box-shadow: 0 -2px 8px rgba(0,0,0,0.15);
              z-index: 9998;
            }

            /* 工具栏存在时页面底部留白 */
            body.wnacg-mobile-has-toolbar {
              padding-bottom: calc(var(--wnacg-toolbar-h) + env(safe-area-inset-bottom, 0px)) !important;
            }

            /* 按钮触控友好 */
            .wnacg-batch-btn {
              min-height: 40px;
              padding: 10px 14px;
              font-size: 13px;
              white-space: nowrap;
            }

            /* checkbox 增大命中区 */
            .wnacg-gallery-checkbox {
              width: 26px;
              height: 26px;
              top: 8px;
              left: 8px;
            }

            /* 进度面板底部全宽 */
            .wnacg-progress-panel {
              left: 0;
              right: 0;
              top: auto;
              width: auto;
              border-radius: 12px 12px 0 0;
              max-height: 60vh;
              overflow-y: auto;
            }
            /* 工具栏存在时进度面板偏移 */
            body.wnacg-mobile-has-toolbar .wnacg-progress-panel {
              bottom: calc(var(--wnacg-toolbar-h) + env(safe-area-inset-bottom, 0px));
            }
            /* 书架页移动端 */
            .wnacg-shelf-toolbar {
              position: sticky;
              top: 0;
              z-index: 9998;
              margin: 0 0 10px 0;
              border-radius: 0 0 12px 12px;
            }
            .wnacg-shelf-checkbox {
              width: 22px;
              height: 22px;
            }
            /* 长按目标元素 */
            .wnacg-longpress-target {
              -webkit-user-select: none;
              user-select: none;
              -webkit-touch-callout: none;
              touch-action: manipulation;
            }
          }
    `;
    injectStyles(baseCSS);
  }

  /**
   * 从相册链接中提取 aid
   * @param {string} href 链接地址
   * @returns {number|null} aid 或 null
   */
  function extractAidFromHref(href) {
    if (!href) return null;

    const raw = String(href);
    const match = raw.match(/photos-(?:index|slist|slide)-aid-(\d+)(?:\.html)?/i);
    if (!match) return null;

    const aid = Number(match[1]);
    return Number.isFinite(aid) ? aid : null;
  }

  /**
   * 查找书架页中所有相册条目链接（去重）
   * @param {Document|HTMLElement} root 根节点
   * @returns {Array<{aid:number, anchor:HTMLAnchorElement}>}
   */
  function findShelfAlbumAnchors(root) {
    const container = root && 'querySelectorAll' in root ? root : document;
    const anchors = Array.from(container.querySelectorAll('a[href]'));

    const seen = new Set();
    const result = [];

    for (const a of anchors) {
      const href = a.getAttribute('href') || a.href;
      const aid = extractAidFromHref(href);
      if (!aid) continue;
      if (seen.has(aid)) continue;

      const text = (a.textContent || '').trim();
      if (!text) continue;

      seen.add(aid);
      result.push({ aid, anchor: a });
    }

    return result;
  }

  /**
   * 请求并解析 HTML 为 Document
   * @param {string} url 页面 URL
   * @returns {Promise<Document|null>}
   */
  async function fetchHtmlDocument(url) {
    if (!/^https?:/i.test(String(url || ''))) {
      return null;
    }
    return new Promise((resolve) => {
      const iframe = document.createElement('iframe');
      iframe.style.cssText = 'position:fixed;left:-99999px;top:-99999px;width:1px;height:1px;opacity:0;pointer-events:none;';
      iframe.src = url;

      let done = false;
      const finish = (doc) => {
        if (done) return;
        done = true;
        try {
          iframe.remove();
        } catch {}
        resolve(doc || null);
      };

      const timer = setTimeout(() => {
        log(`请求分页超时 (${CONFIG.DOWNLOAD.TIMEOUT}ms)`, 'error');
        finish(null);
      }, CONFIG.DOWNLOAD.TIMEOUT);

      iframe.onload = () => {
        clearTimeout(timer);
        try {
          const doc = iframe.contentDocument;
          if (!doc || !doc.documentElement) {
            log('分页 iframe 加载成功但无法读取 contentDocument', 'error');
            finish(null);
            return;
          }

          // 站点对 XHR/fetch 可能返回 403，但 iframe 导航可拿到真实页面。
          // 为避免返回已被移除 iframe 的 live Document，这里转换为纯 Document。
          const html = doc.documentElement.outerHTML;
          const parser = new DOMParser();
          const parsed = parser.parseFromString(html, 'text/html');
          finish(parsed);
        } catch (err) {
          log(`读取分页 iframe 失败: ${err.message}`, 'error');
          finish(null);
        }
      };

      iframe.onerror = () => {
        clearTimeout(timer);
        log('分页 iframe 加载失败', 'error');
        finish(null);
      };

      document.body.appendChild(iframe);
    });
  }

  /**
   * 从书架页 Document 中查找“后页”链接
   * @param {Document} doc
   * @returns {string|null} 下一页绝对 URL
   */
  function findNextShelfPageUrl(doc) {
    const links = Array.from(doc.querySelectorAll('a[href]'));
    const next = links.find((a) => {
      const text = (a.textContent || '').trim();
      if (text.includes('後頁')) return true;
      const href = a.getAttribute('href') || '';
      return href.includes('users-users_fav-page-');
    });

    if (!next) return null;
    const href = next.getAttribute('href') || next.href;
    if (!href) return null;
    try {
      return new URL(href, location.origin).toString();
    } catch {
      return null;
    }
  }

  /**
   * 遍历所有书架分页并收集 aid（防止误触：默认不启用）
   * @param {number} maxPages 最大页数
   * @returns {Promise<number[]>}
   */
  async function collectAllShelfAids(maxPages = 50) {
    const aids = new Set();

    let currentDoc = document;
    let nextUrl = location.href;
    const visited = new Set();

    for (let i = 0; i < maxPages; i++) {
      if (visited.has(nextUrl)) break;
      visited.add(nextUrl);

      const items = findShelfAlbumAnchors(currentDoc);
      for (const { aid } of items) aids.add(aid);

      const foundNext = findNextShelfPageUrl(currentDoc);
      if (!foundNext) break;

      nextUrl = foundNext;
      currentDoc = await fetchHtmlDocument(nextUrl);
      if (!currentDoc) break;
    }

    return Array.from(aids);
  }

  /**
   * 将文件名清理为可下载的安全名字
   * @param {string} filename
   * @returns {string}
   */
  function sanitizeFilename(filename) {
    const raw = String(filename || '').trim();
    const safe = raw
      .replace(/[<>:"/\\|?*]/g, '_')
      .replace(/\s+/g, ' ')
      .trim();

    const limited = safe.length > 200 ? safe.slice(0, 200) : safe;
    return limited || `album_${Date.now()}.zip`;
  }

  /**
   * 获取当前相册页 URL 中的 aid
   * @returns {number|null}
   */
  function extractAidFromLocation() {
    const m = String(location.href).match(/photos-(?:index|slist|slide)-aid-(\d+)(?:\.html)?/i);
    if (!m) return null;
    const aid = Number(m[1]);
    return Number.isFinite(aid) ? aid : null;
  }

  /**
   * 获取当前相册标题（优先页面标题节点，失败时回退 document.title）
   * @returns {string}
   */
  function extractCurrentAlbumTitle() {
    const selectors = [
      '.uwconn h2',
      'h1',
      'h2',
      '.album_title',
      '.photo_title',
      '.title'
    ];

    for (const selector of selectors) {
      const el = document.querySelector(selector);
      const text = (el?.textContent || '').trim();
      if (text && text.length >= 2) return text;
    }

    return String(document.title || '')
      .replace(/\s*-\s*列表.*$/i, '')
      .replace(/\s*-\s*紳士漫畫.*$/i, '')
      .replace(/-紳士漫畫.*$/i, '')
      .trim();
  }

  /**
   * 归一化标题/关键词文本（用于系列匹配）
   * @param {string} input
   * @returns {string}
   */
  function normalizeSeriesText(input) {
    return String(input || '')
      .toLowerCase()
      .replace(/\[[^\]]*\]/g, ' ')
      .replace(/[【】「」『』（）()《》〈〉［］\[\]\s_\-–—:：,，.。!?！？~～|｜\\/]+/g, '')
      .trim();
  }

  /**
   * 从相册标题推断系列关键词（只在明显“话/卷/vol”等系列特征下启用）
   * @param {string} title
   * @returns {string}
   */
  function extractSeriesKeyword(title) {
    let text = String(title || '').trim();
    if (!text) return '';

    // 去掉开头作者/社团等方括号
    text = text.replace(/^\s*(?:\[[^\]]+\]\s*)+/g, '');
    // 中日双语标题通常用 | 分隔，优先取左侧主标题
    text = text.split(/[|｜]/)[0].trim();
    // 去掉末尾翻译组等方括号
    text = text.replace(/\s*(?:\[[^\]]+\]\s*)+$/g, '').trim();

    // 仅在明显系列后缀时启用（如 298-299话 / Vol.12 / Part 3）
    const seriesMarkerRe = /(第?\s*\d+(?:\s*[-~～]\s*\d+)?\s*[话話回卷章部]|(?:vol|VOL)\.?\s*\d+(?:\.\d+)?|#\s*\d+|(?:part|Part)\s*\d+|[上中下前后後]\s*篇?)/;
    if (!seriesMarkerRe.test(text)) return '';

    text = text
      .replace(/\s*(?:第?\s*\d+(?:\s*[-~～]\s*\d+)?\s*[话話回卷章部]|(?:vol|VOL)\.?\s*\d+(?:\.\d+)?|#\s*\d+|(?:part|Part)\s*\d+|[上中下前后後]\s*篇?)+\s*$/gi, '')
      .replace(/[\s\-–—:：,，.。!?！？~～]+$/g, '')
      .trim();

    return text;
  }

  /**
   * 手动搜索时的关键词建议（比自动识别更宽松）
   * @param {string} title
   * @returns {string}
   */
  function deriveSeriesKeywordSuggestion(title) {
    let text = String(title || '').trim();
    if (!text) return '';

    text = text.replace(/^\s*(?:\[[^\]]+\]\s*)+/g, '');
    text = text.split(/[|｜]/)[0].trim();
    text = text.replace(/\s*(?:\[[^\]]+\]\s*)+$/g, '').trim();
    text = text
      .replace(/\s*(?:第?\s*\d+(?:\s*[-~～]\s*\d+)?\s*[话話回卷章部]|(?:vol|VOL)\.?\s*\d+(?:\.\d+)?|#\s*\d+|(?:part|Part)\s*\d+|[上中下前后後]\s*篇?)+\s*$/gi, '')
      .replace(/[\s\-–—:：,，.。!?！？~～]+$/g, '')
      .trim();

    return text;
  }

  /**
   * 从列表/搜索页面中提取相册条目
   * @param {Document} doc
   * @param {number} maxItems
   * @returns {Array<{aid:number,title:string,url:string}>}
   */
  function collectAlbumEntriesFromDoc(doc, maxItems = 80) {
    const links = Array.from(doc.querySelectorAll('a[href]'));
    const map = new Map();

    for (const link of links) {
      const href = link.getAttribute('href') || link.href || '';
      const aid = extractAidFromHref(href);
      if (!aid) continue;

      const text = (link.textContent || '').trim();
      const title = text || (link.getAttribute('title') || '').trim() || (link.querySelector('img')?.getAttribute('alt') || '').trim();
      const url = `${location.origin}/photos-index-aid-${aid}.html`;

      if (!map.has(aid)) {
        map.set(aid, { aid, title, url });
      } else if (title && !map.get(aid).title) {
        map.set(aid, { aid, title, url });
      }

      if (map.size >= maxItems) break;
    }

    return Array.from(map.values());
  }

  /**
   * 读取 localStorage JSON（容错）
   * @param {string} key
   * @param {object} fallback
   * @returns {object}
   */
  function readLocalJSON(key, fallback = {}) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      const data = JSON.parse(raw);
      return data && typeof data === 'object' ? data : fallback;
    } catch {
      return fallback;
    }
  }

  /**
   * 写入 localStorage JSON（容错）
   * @param {string} key
   * @param {object} value
   */
  function writeLocalJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  }

  /**
   * 画廊热度自动标注开关（默认开启）
   * @returns {boolean}
   */
  function getGalleryPopularityAutoEnabled() {
    try {
      const raw = localStorage.getItem(GALLERY_POPULARITY_AUTO_KEY);
      if (raw === null) return true;
      return raw === '1';
    } catch {
      return true;
    }
  }

  /**
   * 设置画廊热度自动标注开关
   * @param {boolean} enabled
   */
  function setGalleryPopularityAutoEnabled(enabled) {
    try {
      localStorage.setItem(GALLERY_POPULARITY_AUTO_KEY, enabled ? '1' : '0');
    } catch {}
  }

  /**
   * 统一转绝对 URL
   * @param {string} href
   * @param {string} baseUrl
   * @returns {string}
   */
  function toAbsoluteUrl(href, baseUrl = location.origin) {
    try {
      return new URL(href, baseUrl).toString();
    } catch {
      return '';
    }
  }

  /**
   * 识别排行时间维度（本日/本周/本月）
   * @param {string} text
   * @param {string} href
   * @returns {'day'|'week'|'month'|null}
   */
  function detectRankScope(text, href = '') {
    const t = String(text || '').toLowerCase();
    const h = String(href || '').toLowerCase();
    const mix = `${t} ${h}`;

    if (/(?:本日|今日|日榜|daily|today|24h|24小時|24小时|byday|dayrank)/i.test(mix)) return 'day';
    if (/(?:本週|本周|周榜|weekly|week|7d|7days|7天|byweek|weekrank)/i.test(mix)) return 'week';
    if (/(?:本月|月榜|monthly|month|30d|30days|30天|bymonth|monthrank)/i.test(mix)) return 'month';
    return null;
  }

  /**
   * 判断是否是“排行入口”链接
   * @param {string} text
   * @param {string} href
   * @returns {boolean}
   */
  function isRankEntryLink(text, href) {
    const t = String(text || '').toLowerCase();
    const h = String(href || '').toLowerCase();
    return /(?:排行|排名|热门|人氣|人气|hot|rank|ranking|top)/i.test(`${t} ${h}`);
  }

  /**
   * 从页面中抽取可用的 day/week/month 排行 URL
   * @param {Document} doc
   * @param {string} baseUrl
   * @param {object} seed
   * @returns {{day:string,week:string,month:string,entry:string}}
   */
  function extractRankUrlsFromDocument(doc, baseUrl = location.origin, seed = {}) {
    const result = {
      day: seed.day || '',
      week: seed.week || '',
      month: seed.month || '',
      entry: seed.entry || ''
    };
    if (!doc) return result;

    const links = Array.from(doc.querySelectorAll('a[href]'));
    for (const link of links) {
      const href = link.getAttribute('href') || link.href || '';
      if (!href) continue;

      const abs = toAbsoluteUrl(href, baseUrl);
      if (!abs) continue;

      const text = String(link.textContent || '').trim();
      const scope = detectRankScope(text, abs);
      if (scope && !result[scope]) {
        result[scope] = abs;
      }

      if (!result.entry && isRankEntryLink(text, abs)) {
        result.entry = abs;
      }
    }

    return result;
  }

  /**
   * 发现排行榜 URL（优先当前页，必要时抓取排行入口页）
   * @returns {Promise<{day:string,week:string,month:string,entry:string}>}
   */
  async function discoverPopularityRankUrls() {
    let discovered = extractRankUrlsFromDocument(document, location.href, {});

    const needMore = !discovered.day || !discovered.week || !discovered.month;
    if (needMore && discovered.entry) {
      const rankDoc = await fetchHtmlDocument(discovered.entry);
      if (rankDoc) {
        discovered = extractRankUrlsFromDocument(rankDoc, discovered.entry, discovered);
      }
    }

    // 兜底：至少有排行入口时，把入口当作月榜信号（不覆盖已识别值）
    if (discovered.entry && !discovered.month) {
      discovered.month = discovered.entry;
    }

    return discovered;
  }

  /**
   * 从列表页文档提取按页面顺序排列的 aid
   * @param {Document} doc
   * @param {number} maxItems
   * @returns {number[]}
   */
  function collectRankedAidsFromDoc(doc, maxItems = 200) {
    const aids = [];
    const seen = new Set();
    const addAid = (href) => {
      const aid = extractAidFromHref(href);
      if (!aid || seen.has(aid)) return;
      seen.add(aid);
      aids.push(aid);
    };

    const preferredSelectors = [
      'li.gallary_item a[href]',
      '.gallary_item a[href]',
      '.gallery_item a[href]',
      '.gallary_wrap a[href]',
      '.pic_box a[href]'
    ];

    for (const selector of preferredSelectors) {
      const nodes = Array.from(doc.querySelectorAll(selector));
      for (const node of nodes) {
        const href = node.getAttribute('href') || node.href || '';
        addAid(href);
        if (aids.length >= maxItems) return aids;
      }
      if (aids.length >= 8) break;
    }

    if (aids.length < 8) {
      const fallback = Array.from(doc.querySelectorAll('a[href*="photos-index-aid-"], a[href*="photos-slist-aid-"], a[href*="photos-slide-aid-"]'));
      for (const node of fallback) {
        const href = node.getAttribute('href') || node.href || '';
        addAid(href);
        if (aids.length >= maxItems) return aids;
      }
    }

    return aids;
  }

  /**
   * 从列表页查找“下一页”链接
   * @param {Document} doc
   * @param {string} currentUrl
   * @returns {string}
   */
  function findNextListPageUrl(doc, currentUrl) {
    const links = Array.from(doc.querySelectorAll('a[href]'));
    const next = links.find((a) => {
      const text = String(a.textContent || '').trim();
      if (/(?:後頁|后页|下一頁|下一页|next|>>)/i.test(text)) return true;
      const cls = String(a.className || '');
      if (/next/i.test(cls)) return true;
      return false;
    });
    if (!next) return '';

    const href = next.getAttribute('href') || next.href || '';
    if (!href) return '';
    return toAbsoluteUrl(href, currentUrl || location.origin);
  }

  /**
   * 分页抓取排行 aid
   * @param {string} startUrl
   * @param {number} maxPages
   * @param {number} maxItems
   * @returns {Promise<number[]>}
   */
  async function collectRankedAidsFromPagedUrl(startUrl, maxPages = 4, maxItems = 260) {
    const all = [];
    const seen = new Set();
    const visited = new Set();
    let currentUrl = startUrl;

    for (let page = 0; page < maxPages; page += 1) {
      if (!currentUrl || visited.has(currentUrl)) break;
      visited.add(currentUrl);

      const doc = await fetchHtmlDocument(currentUrl);
      if (!doc) break;

      const pageAids = collectRankedAidsFromDoc(doc, maxItems);
      for (const aid of pageAids) {
        if (seen.has(aid)) continue;
        seen.add(aid);
        all.push(aid);
        if (all.length >= maxItems) return all;
      }

      const nextUrl = findNextListPageUrl(doc, currentUrl);
      if (!nextUrl || visited.has(nextUrl)) break;
      currentUrl = nextUrl;
    }

    return all;
  }

  /**
   * 计算归一化排名分（0~1）
   * @param {number} rank
   * @param {number} listSize
   * @returns {number|null}
   */
  function getRankPercentileScore(rank, listSize) {
    if (!Number.isFinite(rank) || !Number.isFinite(listSize) || listSize <= 0) return null;
    const score = 1 - (rank - 1) / listSize;
    return Math.max(0, Math.min(1, score));
  }

  /**
   * 按权重计算均值（忽略空值）
   * @param {Array<{value:number|null,weight:number}>} items
   * @returns {number|null}
   */
  function weightedAverage(items) {
    let num = 0;
    let den = 0;
    for (const item of items || []) {
      const value = item?.value;
      const weight = Number(item?.weight || 0);
      if (!Number.isFinite(value) || weight <= 0) continue;
      num += value * weight;
      den += weight;
    }
    if (den <= 0) return null;
    return num / den;
  }

  /**
   * 提取相册发布日期
   * @returns {Date|null}
   */
  function extractAlbumPublishDate() {
    const nodes = document.querySelectorAll('.tagshow, .uwconn, .asTB, .pic_box_tb, .download_btns, .viewthread');
    const dateRe = /(?:上傳|上传|日期|發佈|发布|更新)\s*[：:]\s*(\d{4}[\/.\-]\d{1,2}[\/.\-]\d{1,2})/i;
    const fallbackDateRe = /(\d{4}[\/.\-]\d{1,2}[\/.\-]\d{1,2})/;

    for (const node of nodes) {
      const text = String(node.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;

      const explicit = text.match(dateRe);
      const matched = explicit?.[1] || text.match(fallbackDateRe)?.[1] || '';
      if (!matched) continue;

      const normalized = matched.replace(/[/.]/g, '-');
      const date = new Date(`${normalized}T00:00:00`);
      if (Number.isFinite(date.getTime())) return date;
    }

    return null;
  }

  /**
   * 获取作品距今天数
   * @returns {number|null}
   */
  function getAlbumAgeDays() {
    const date = extractAlbumPublishDate();
    if (!date) return null;
    const diff = Date.now() - date.getTime();
    if (!Number.isFinite(diff)) return null;
    return Math.max(0, Math.floor(diff / 86400000));
  }

  /**
   * 返回热度等级
   * @param {number|null} score
   * @returns {{label:string,name:string,className:string}}
   */
  function getPopularityGrade(score) {
    if (!Number.isFinite(score)) return { label: 'N/A', name: '暂无数据', className: 'wnacg-hot-d' };
    if (score >= 0.8) return { label: 'S', name: '爆款', className: 'wnacg-hot-s' };
    if (score >= 0.65) return { label: 'A', name: '很热', className: 'wnacg-hot-a' };
    if (score >= 0.5) return { label: 'B', name: '较热', className: 'wnacg-hot-b' };
    if (score >= 0.35) return { label: 'C', name: '普通', className: 'wnacg-hot-c' };
    return { label: 'D', name: '冷门', className: 'wnacg-hot-d' };
  }

  /**
   * 热度等级文本（给用户看）
   * @param {{label?:string,name?:string}|null} grade
   * @returns {string}
   */
  function formatPopularityGradeLabel(grade) {
    const label = String(grade?.label || '').trim();
    const name = String(grade?.name || '').trim();
    if (!label || label === 'N/A') return '暂无分级';
    return name ? `${label}档（${name}）` : `${label}档`;
  }

  /**
   * 热度文案说明
   * @returns {string}
   */
  function getPopularityLegendText() {
    return '热度 0-100 分，越高越热门；S=爆款，A=很热，B=较热，C=普通，D=冷门';
  }

  /**
   * 趋势描述
   * @param {number|null} delta
   * @returns {{symbol:string,label:string,className:string}}
   */
  function getTrendDescriptor(delta) {
    if (!Number.isFinite(delta)) return { symbol: '—', label: '无趋势数据', className: 'wnacg-popularity-trend-flat' };
    if (delta >= 0.05) return { symbol: '↑', label: '上升', className: 'wnacg-popularity-trend-up' };
    if (delta <= -0.05) return { symbol: '↓', label: '下降', className: 'wnacg-popularity-trend-down' };
    return { symbol: '→', label: '平稳', className: 'wnacg-popularity-trend-flat' };
  }

  /**
   * 读取缓存
   * @param {string} cacheKey
   * @returns {any|null}
   */
  function getPopularityCache(cacheKey) {
    const cacheMap = readLocalJSON(POPULARITY_CACHE_KEY, {});
    const item = cacheMap[cacheKey];
    if (!item || !Number.isFinite(item.ts)) return null;
    const ttlMs = 6 * 60 * 60 * 1000;
    if (Date.now() - item.ts > ttlMs) return null;
    return item.data || null;
  }

  /**
   * 写缓存
   * @param {string} cacheKey
   * @param {any} data
   */
  function setPopularityCache(cacheKey, data) {
    const cacheMap = readLocalJSON(POPULARITY_CACHE_KEY, {});
    cacheMap[cacheKey] = { ts: Date.now(), data };
    writeLocalJSON(POPULARITY_CACHE_KEY, cacheMap);
  }

  /**
   * 读取远程榜单缓存
   * @param {string} key
   * @param {number} ttlMs
   * @returns {any|null}
   */
  function getRemoteRankCache(key, ttlMs) {
    const map = readLocalJSON(POPULARITY_REMOTE_CACHE_KEY, {});
    const item = map[key];
    if (!item || !Number.isFinite(item.ts)) return null;
    if (Date.now() - item.ts > ttlMs) return null;
    return item.data ?? null;
  }

  /**
   * 写入远程榜单缓存
   * @param {string} key
   * @param {any} data
   */
  function setRemoteRankCache(key, data) {
    const map = readLocalJSON(POPULARITY_REMOTE_CACHE_KEY, {});
    map[key] = { ts: Date.now(), data };
    writeLocalJSON(POPULARITY_REMOTE_CACHE_KEY, map);
  }

  /**
   * 通过 GM_xmlhttpRequest 请求跨域 HTML 文档
   * @param {string} url
   * @param {number} timeoutMs
   * @returns {Promise<Document|null>}
   */
  async function fetchRemoteHtmlDocument(url, timeoutMs = 20000) {
    if (typeof GM_xmlhttpRequest !== 'function') return null;

    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: timeoutMs,
        headers: {
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
        },
        onload: (resp) => {
          try {
            if (!resp || resp.status < 200 || resp.status >= 400 || !resp.responseText) {
              resolve(null);
              return;
            }
            const parser = new DOMParser();
            const doc = parser.parseFromString(resp.responseText, 'text/html');
            resolve(doc);
          } catch {
            resolve(null);
          }
        },
        ontimeout: () => resolve(null),
        onerror: () => resolve(null)
      });
    });
  }

  /**
   * 用于跨站匹配的标题归一化
   * @param {string} input
   * @returns {string}
   */
  function normalizePopularityTitle(input) {
    return String(input || '')
      .toLowerCase()
      .replace(/<[^>]*>/g, ' ')
      .replace(/&(?:lt|gt|amp|quot|#39);/gi, ' ')
      .replace(/^\s*(?:\[[^\]]+\]\s*)+/g, '')
      .replace(/\s*(?:\[[^\]]+\]\s*)+$/g, '')
      .replace(/[【】「」『』（）()《》〈〉［］\[\]\s_\-–—:：,，.。!?！？~～|｜\\/]+/g, '')
      .trim();
  }

  /**
   * 构建跨站标题候选（用于模糊匹配）
   * @param {string} rawTitle
   * @returns {string[]}
   */
  function buildPopularityTitleCandidates(rawTitle) {
    const raw = String(rawTitle || '').trim();
    if (!raw) return [];

    const candidates = new Set();
    const add = (value) => {
      const normalized = normalizePopularityTitle(value);
      if (normalized && normalized.length >= 3) candidates.add(normalized);
    };

    add(raw);
    add(raw.split(/[|｜]/)[0] || '');
    add(raw.replace(/^\s*(?:\[[^\]]+\]\s*)+/g, '').trim());
    add(raw.replace(/\s*(?:\[[^\]]+\]\s*)+$/g, '').trim());

    const bracketed = raw.match(/\[[^\]]+\]/g) || [];
    for (const segment of bracketed) add(segment);

    const latinSegments = raw.match(/[a-z0-9][a-z0-9 ._+\-]{2,}/gi) || [];
    for (const segment of latinSegments) add(segment);

    return Array.from(candidates).slice(0, 12);
  }

  /**
   * 字符串拆分为 2-gram
   * @param {string} value
   * @returns {string[]}
   */
  function toBiGrams(value) {
    const text = String(value || '');
    if (!text) return [];
    if (text.length <= 2) return [text];
    const grams = [];
    for (let i = 0; i < text.length - 1; i += 1) {
      grams.push(text.slice(i, i + 2));
    }
    return grams;
  }

  /**
   * 计算标题相似度（0~1）
   * @param {string} a
   * @param {string} b
   * @returns {number}
   */
  function calculateTitleSimilarity(a, b) {
    const x = normalizePopularityTitle(a);
    const y = normalizePopularityTitle(b);
    if (!x || !y) return 0;
    if (x === y) return 1;
    if (x.includes(y) || y.includes(x)) return 0.9;

    const gramsX = new Set(toBiGrams(x));
    const gramsY = new Set(toBiGrams(y));
    if (gramsX.size === 0 || gramsY.size === 0) return 0;

    let intersection = 0;
    for (const gram of gramsX) {
      if (gramsY.has(gram)) intersection += 1;
    }
    const union = gramsX.size + gramsY.size - intersection;
    if (union <= 0) return 0;
    return intersection / union;
  }

  /**
   * 从榜单页面提取有序标题
   * @param {Document} doc
   * @param {RegExp} hrefPattern
   * @param {number} maxItems
   * @returns {Array<{rank:number,title:string,url:string,normalized:string}>}
   */
  function collectRankedTitlesFromDoc(doc, hrefPattern, maxItems = 120) {
    const links = Array.from(doc.querySelectorAll('a[href]'));
    const items = [];
    const seen = new Set();

    for (const link of links) {
      const href = link.getAttribute('href') || link.href || '';
      if (!hrefPattern.test(href)) continue;

      const text = String(link.textContent || '').trim() || String(link.getAttribute('title') || '').trim();
      const normalized = normalizePopularityTitle(text);
      if (!normalized || normalized.length < 3) continue;

      const key = `${normalized}::${href}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const url = toAbsoluteUrl(href, location.origin);
      items.push({
        rank: items.length + 1,
        title: text,
        url,
        normalized
      });

      if (items.length >= maxItems) break;
    }

    return items;
  }

  /**
   * 在榜单中按标题匹配目标作品
   * @param {string[]} targetCandidates
   * @param {Array<{rank:number,title:string,url:string,normalized:string}>} rankedItems
   * @returns {{rank:number|null,listSize:number,score:number|null,matchScore:number|null,title:string,url:string}}
   */
  function matchTargetInRankedTitles(targetCandidates, rankedItems) {
    if (!Array.isArray(rankedItems) || rankedItems.length === 0) {
      return { rank: null, listSize: 0, score: null, matchScore: null, title: '', url: '' };
    }

    let best = null;
    for (const item of rankedItems) {
      let bestMatchScore = 0;
      for (const candidate of targetCandidates) {
        const score = calculateTitleSimilarity(candidate, item.normalized || item.title);
        if (score > bestMatchScore) bestMatchScore = score;
      }

      if (bestMatchScore < 0.45) continue;
      if (!best || bestMatchScore > best.matchScore || (bestMatchScore === best.matchScore && item.rank < best.rank)) {
        best = {
          rank: item.rank,
          listSize: rankedItems.length,
          matchScore: bestMatchScore,
          title: item.title,
          url: item.url
        };
      }
    }

    if (!best) {
      return { rank: null, listSize: rankedItems.length, score: null, matchScore: null, title: '', url: '' };
    }

    const rankScore = getRankPercentileScore(best.rank, best.listSize);
    const score = weightedAverage([
      { value: rankScore, weight: 0.75 },
      { value: best.matchScore, weight: 0.25 }
    ]);

    return {
      rank: best.rank,
      listSize: best.listSize,
      score,
      matchScore: best.matchScore,
      title: best.title,
      url: best.url
    };
  }

  /**
   * 获取 EH 榜单（单 scope）
   * @param {'day'|'month'|'all'} scope
   * @returns {Promise<{scope:string,url:string,items:Array}>}
   */
  async function fetchEHToplistScope(scope) {
    const tlMap = { day: 15, month: 13, all: 11 };
    const tl = tlMap[scope];
    if (!tl) return { scope, url: '', items: [] };

    const url = `https://e-hentai.org/toplist.php?tl=${tl}`;
    const cacheKey = `eh_toplist_${scope}`;
    const cached = getRemoteRankCache(cacheKey, 3 * 60 * 60 * 1000);
    if (cached) return cached;

    const doc = await fetchRemoteHtmlDocument(url);
    if (!doc) {
      const failed = { scope, url, items: [] };
      setRemoteRankCache(cacheKey, failed);
      return failed;
    }

    const items = collectRankedTitlesFromDoc(doc, /\/g\/\d+\//i, 140);
    const data = { scope, url, items };
    setRemoteRankCache(cacheKey, data);
    return data;
  }

  /**
   * 计算 EH 跨站热度
   * @param {string[]} titleCandidates
   * @returns {Promise<{score:number|null,scopes:any,source:string}>}
   */
  async function computeEHPopularityByTitle(titleCandidates) {
    const [dayData, monthData, allData] = await Promise.all([
      fetchEHToplistScope('day'),
      fetchEHToplistScope('month'),
      fetchEHToplistScope('all')
    ]);

    const day = matchTargetInRankedTitles(titleCandidates, dayData.items);
    const month = matchTargetInRankedTitles(titleCandidates, monthData.items);
    const all = matchTargetInRankedTitles(titleCandidates, allData.items);

    const score = weightedAverage([
      { value: day.score, weight: 0.45 },
      { value: month.score, weight: 0.35 },
      { value: all.score, weight: 0.2 }
    ]);

    return {
      source: 'E-Hentai',
      score,
      scopes: {
        day: { ...day, url: dayData.url },
        month: { ...month, url: monthData.url },
        all: { ...all, url: allData.url }
      }
    };
  }

  /**
   * 获取 DLsite 榜单（单 scope）
   * @param {'week'|'month'|'all'} scope
   * @returns {Promise<{scope:string,url:string,items:Array}>}
   */
  async function fetchDLsiteRankingScope(scope) {
    const urlMap = {
      week: 'https://www.dlsite.com/home/ranking/',
      month: 'https://www.dlsite.com/home/ranking/=/term/month',
      all: 'https://www.dlsite.com/home/ranking/=/term/total'
    };
    const url = urlMap[scope] || '';
    if (!url) return { scope, url: '', items: [] };

    const cacheKey = `dlsite_rank_${scope}`;
    const cached = getRemoteRankCache(cacheKey, 6 * 60 * 60 * 1000);
    if (cached) return cached;

    const doc = await fetchRemoteHtmlDocument(url);
    if (!doc) {
      const failed = { scope, url, items: [] };
      setRemoteRankCache(cacheKey, failed);
      return failed;
    }

    const items = collectRankedTitlesFromDoc(doc, /\/home\/work\/=.*product_id\//i, 140);
    const data = { scope, url, items };
    setRemoteRankCache(cacheKey, data);
    return data;
  }

  /**
   * 计算 DLsite 跨站热度
   * @param {string[]} titleCandidates
   * @returns {Promise<{score:number|null,scopes:any,source:string}>}
   */
  async function computeDLsitePopularityByTitle(titleCandidates) {
    const [weekData, monthData, allData] = await Promise.all([
      fetchDLsiteRankingScope('week'),
      fetchDLsiteRankingScope('month'),
      fetchDLsiteRankingScope('all')
    ]);

    const week = matchTargetInRankedTitles(titleCandidates, weekData.items);
    const month = matchTargetInRankedTitles(titleCandidates, monthData.items);
    const all = matchTargetInRankedTitles(titleCandidates, allData.items);

    const score = weightedAverage([
      { value: week.score, weight: 0.4 },
      { value: month.score, weight: 0.35 },
      { value: all.score, weight: 0.25 }
    ]);

    return {
      source: 'DLsite',
      score,
      scopes: {
        week: { ...week, url: weekData.url },
        month: { ...month, url: monthData.url },
        all: { ...all, url: allData.url }
      }
    };
  }

  /**
   * 更新历史并计算长期热度与趋势
   * @param {string} historyKey
   * @param {number|null} recentScore
   * @returns {{longterm:number|null,trendDelta:number|null,sampleCount30d:number,appearRate30d:number|null,avgRecent30d:number|null}}
   */
  function updatePopularityHistoryAndCompute(historyKey, recentScore) {
    const historyMap = readLocalJSON(POPULARITY_HISTORY_KEY, {});
    const now = Date.now();
    const keepSince = now - 120 * 86400000;
    const window30 = now - 30 * 86400000;

    const prev = Array.isArray(historyMap[historyKey]) ? historyMap[historyKey] : [];
    const cleaned = prev
      .filter((item) => item && Number.isFinite(item.ts) && item.ts >= keepSince)
      .map((item) => ({
        ts: item.ts,
        present: Boolean(item.present),
        recent: Number.isFinite(item.recent) ? item.recent : null
      }));

    let trendDelta = null;
    const previousFiniteRecent = cleaned
      .map((item) => item.recent)
      .filter((v) => Number.isFinite(v));

    if (Number.isFinite(recentScore) && previousFiniteRecent.length > 0) {
      const last3 = previousFiniteRecent.slice(-3);
      const avg3 = last3.reduce((sum, v) => sum + v, 0) / last3.length;
      trendDelta = recentScore - avg3;
    }

    cleaned.push({
      ts: now,
      present: Number.isFinite(recentScore),
      recent: Number.isFinite(recentScore) ? recentScore : null
    });

    historyMap[historyKey] = cleaned.slice(-160);
    writeLocalJSON(POPULARITY_HISTORY_KEY, historyMap);

    const recent30d = historyMap[historyKey].filter((item) => item.ts >= window30);
    const sampleCount30d = recent30d.length;
    if (sampleCount30d === 0) {
      return { longterm: null, trendDelta, sampleCount30d: 0, appearRate30d: null, avgRecent30d: null };
    }

    const appeared = recent30d.filter((item) => item.present);
    const appearRate30d = appeared.length / sampleCount30d;
    const avgRecent30d = appeared.length > 0
      ? appeared.reduce((sum, item) => sum + (item.recent || 0), 0) / appeared.length
      : 0;

    const longterm = 0.6 * appearRate30d + 0.4 * avgRecent30d;
    return { longterm, trendDelta, sampleCount30d, appearRate30d, avgRecent30d };
  }

  /**
   * 计算单个榜单中的排名信息
   * @param {number} aid
   * @param {string} url
   * @returns {Promise<{url:string,rank:number|null,listSize:number,score:number|null}>}
   */
  async function evaluateScopeRank(aid, url) {
    if (!url) return { url: '', rank: null, listSize: 0, score: null };
    const rankedAids = await collectRankedAidsFromPagedUrl(url, 4, 260);
    if (rankedAids.length === 0) return { url, rank: null, listSize: 0, score: null };

    const index = rankedAids.indexOf(aid);
    if (index < 0) return { url, rank: null, listSize: rankedAids.length, score: null };

    const rank = index + 1;
    return {
      url,
      rank,
      listSize: rankedAids.length,
      score: getRankPercentileScore(rank, rankedAids.length)
    };
  }

  /**
   * 计算相册热度（近期 + 长期 + 年龄加权）
   * @param {number} aid
   * @param {{forceRefresh?: boolean}} options
   * @returns {Promise<any>}
   */
  async function computeAlbumPopularity(aid, options = {}) {
    const forceRefresh = Boolean(options.forceRefresh);
    const cacheKey = `${location.host}::${aid}`;
    if (!forceRefresh) {
      const cached = getPopularityCache(cacheKey);
      if (cached) return { ...cached, _fromCache: true };
    }

    const rankUrls = await discoverPopularityRankUrls();
    const [day, week, month] = await Promise.all([
      evaluateScopeRank(aid, rankUrls.day),
      evaluateScopeRank(aid, rankUrls.week),
      evaluateScopeRank(aid, rankUrls.month)
    ]);

    const wnacgScore = weightedAverage([
      { value: day.score, weight: 0.5 },
      { value: week.score, weight: 0.3 },
      { value: month.score, weight: 0.2 }
    ]);

    const currentTitle = extractCurrentAlbumTitle();
    const titleCandidates = buildPopularityTitleCandidates(currentTitle);
    const [ehScoreData, dlsiteScoreData] = await Promise.all([
      computeEHPopularityByTitle(titleCandidates),
      computeDLsitePopularityByTitle(titleCandidates)
    ]);

    const recentScore = weightedAverage([
      { value: wnacgScore, weight: 0.72 },
      { value: ehScoreData.score, weight: 0.2 },
      { value: dlsiteScoreData.score, weight: 0.08 }
    ]);

    const historyKey = `${location.host}::${aid}`;
    const historyStats = updatePopularityHistoryAndCompute(historyKey, recentScore);
    const ageDays = getAlbumAgeDays();

    const recentWeight = Number.isFinite(ageDays) ? (ageDays <= 30 ? 0.7 : 0.3) : 0.5;
    const longtermWeight = Number.isFinite(ageDays) ? (ageDays <= 30 ? 0.3 : 0.7) : 0.5;
    const finalScore = weightedAverage([
      { value: recentScore, weight: recentWeight },
      { value: historyStats.longterm, weight: longtermWeight }
    ]);

    const grade = getPopularityGrade(finalScore);
    const data = {
      aid,
      computedAt: Date.now(),
      rankUrls,
      scopes: { day, week, month },
      sourceScores: {
        wnacg: wnacgScore,
        eh: ehScoreData.score,
        dlsite: dlsiteScoreData.score
      },
      external: {
        eh: ehScoreData,
        dlsite: dlsiteScoreData
      },
      titleCandidates,
      recentScore,
      longtermScore: historyStats.longterm,
      finalScore,
      ageDays,
      sampleCount30d: historyStats.sampleCount30d,
      appearRate30d: historyStats.appearRate30d,
      avgRecent30d: historyStats.avgRecent30d,
      trendDelta: historyStats.trendDelta,
      grade
    };

    setPopularityCache(cacheKey, data);
    return data;
  }

  /**
   * 创建/获取相册热度面板
   * @param {HTMLElement|null} referenceEl
   * @returns {HTMLElement}
   */
  function ensureAlbumPopularityPanel(referenceEl) {
    let panel = document.getElementById('wnacg-popularity-panel');
    if (panel) return panel;

    panel = document.createElement('div');
    panel.id = 'wnacg-popularity-panel';
    panel.className = 'wnacg-popularity-panel';
    panel.innerHTML = `
      <div class="wnacg-popularity-header">
        <div class="wnacg-popularity-title">热度评估（时效+长期）</div>
        <button id="wnacg-popularity-refresh" class="wnacg-popularity-refresh">刷新热度</button>
      </div>
      <div id="wnacg-popularity-main" class="wnacg-popularity-main">热度计算中...</div>
      <div class="wnacg-popularity-help">${getPopularityLegendText()}</div>
      <div id="wnacg-popularity-meta" class="wnacg-popularity-meta">准备抓取本日/本周/本月榜...</div>
    `;

    const host = referenceEl?.closest('.download_btns, .ads, .asTB') || referenceEl?.parentElement || document.body;
    if (host && host.parentElement) {
      host.insertAdjacentElement('afterend', panel);
    } else {
      document.body.insertBefore(panel, document.body.firstChild);
    }

    return panel;
  }

  /**
   * 设置热度面板为加载态
   * @param {HTMLElement} panel
   * @param {string} message
   */
  function setAlbumPopularityLoading(panel, message = '热度计算中...') {
    const main = panel.querySelector('#wnacg-popularity-main');
    const meta = panel.querySelector('#wnacg-popularity-meta');
    if (main) {
      main.className = 'wnacg-popularity-main';
      main.textContent = message;
    }
    if (meta) {
      meta.textContent = '正在抓取榜单并计算，请稍候...';
    }
  }

  /**
   * 将榜单结果格式化为文本
   * @param {string} label
   * @param {{rank:number|null,listSize:number,score:number|null,url:string}} scope
   * @returns {string}
   */
  function formatScopeText(label, scope) {
    if (!scope?.url) return `${label}榜：未发现入口`;
    if (Number.isFinite(scope.rank)) return `${label}榜：#${scope.rank}/${scope.listSize}`;
    if (scope.listSize > 0) return `${label}榜：未上榜（样本 ${scope.listSize}）`;
    return `${label}榜：抓取失败`;
  }

  /**
   * 格式化跨站来源摘要
   * @param {string} label
   * @param {{score:number|null,scopes?:object}} sourceData
   * @returns {string}
   */
  function formatExternalSourceSummary(label, sourceData) {
    if (!sourceData) return `${label}: 无数据`;
    const scoreText = Number.isFinite(sourceData.score) ? Math.round(sourceData.score * 100) : 'N/A';

    const matchedScopes = [];
    for (const [key, val] of Object.entries(sourceData.scopes || {})) {
      if (Number.isFinite(val?.rank)) {
        matchedScopes.push(`${key}#${val.rank}`);
      }
    }
    const matchedText = matchedScopes.length > 0 ? matchedScopes.join(', ') : '未匹配';
    return `${label}: ${scoreText}（${matchedText}）`;
  }

  /**
   * 渲染热度结果
   * @param {HTMLElement} panel
   * @param {any} result
   */
  function renderAlbumPopularityResult(panel, result) {
    const main = panel.querySelector('#wnacg-popularity-main');
    const meta = panel.querySelector('#wnacg-popularity-meta');
    const trend = getTrendDescriptor(result.trendDelta);
    const grade = getPopularityGrade(result.finalScore);
    const recentText = Number.isFinite(result.recentScore) ? `${Math.round(result.recentScore * 100)}` : 'N/A';
    const longtermText = Number.isFinite(result.longtermScore) ? `${Math.round(result.longtermScore * 100)}` : 'N/A';
    const wnacgText = Number.isFinite(result.sourceScores?.wnacg) ? `${Math.round(result.sourceScores.wnacg * 100)}` : 'N/A';
    const ehText = Number.isFinite(result.sourceScores?.eh) ? `${Math.round(result.sourceScores.eh * 100)}` : 'N/A';
    const dlText = Number.isFinite(result.sourceScores?.dlsite) ? `${Math.round(result.sourceScores.dlsite * 100)}` : 'N/A';
    const ageMode = Number.isFinite(result.ageDays)
      ? (result.ageDays <= 30 ? `新作模式（${result.ageDays} 天）` : `老作品模式（${result.ageDays} 天）`)
      : '年龄未知（均衡模式）';

    if (main) {
      main.className = `wnacg-popularity-main ${grade.className} ${trend.className}`.trim();
      main.textContent = Number.isFinite(result.finalScore)
        ? `综合热度：${Math.round(result.finalScore * 100)}分（${formatPopularityGradeLabel(grade)}） ${trend.symbol}`
        : '综合热度：暂无可用热度';
      main.title = `趋势：${trend.label}\n${getPopularityLegendText()}`;
    }

    if (meta) {
      meta.innerHTML = [
        `${formatScopeText('日', result.scopes.day)} ｜ ${formatScopeText('周', result.scopes.week)} ｜ ${formatScopeText('月', result.scopes.month)}`,
        `分级：${formatPopularityGradeLabel(grade)} ｜ ${getPopularityLegendText()}`,
        `站内分：${wnacgText} ｜ EH：${ehText} ｜ DLsite：${dlText}`,
        `${formatExternalSourceSummary('EH匹配', result.external?.eh)} ｜ ${formatExternalSourceSummary('DL匹配', result.external?.dlsite)}`,
        `近期分：${recentText} ｜ 长期分：${longtermText} ｜ ${ageMode}`,
        `30天采样：${result.sampleCount30d} 次，趋势：${trend.label}${result._fromCache ? '（缓存）' : ''}`
      ].join('<br>');
    }
  }

  /**
   * 加载并渲染相册热度
   * @param {number} aid
   * @param {HTMLElement} panel
   * @param {{forceRefresh?:boolean}} options
   */
  async function loadAndRenderAlbumPopularity(aid, panel, options = {}) {
    const refreshBtn = panel.querySelector('#wnacg-popularity-refresh');
    if (refreshBtn) refreshBtn.disabled = true;
    setAlbumPopularityLoading(panel, options.forceRefresh ? '热度刷新中...' : '热度计算中...');

    try {
      const result = await computeAlbumPopularity(aid, options);
      renderAlbumPopularityResult(panel, result);
      return result;
    } catch (error) {
      const main = panel.querySelector('#wnacg-popularity-main');
      const meta = panel.querySelector('#wnacg-popularity-meta');
      if (main) {
        main.className = 'wnacg-popularity-main wnacg-hot-d';
        main.textContent = '热度计算失败';
      }
      if (meta) {
        meta.textContent = `失败原因：${error.message}`;
      }
      log(`热度计算失败: ${error.message}`, 'warn');
      return null;
    } finally {
      if (refreshBtn) refreshBtn.disabled = false;
    }
  }

  /**
   * 绑定热度刷新按钮
   * @param {HTMLElement} panel
   * @param {number} aid
   */
  function bindAlbumPopularityRefresh(panel, aid) {
    if (!panel) return;
    panel.dataset.aid = String(aid);

    const refreshBtn = panel.querySelector('#wnacg-popularity-refresh');
    if (!refreshBtn || refreshBtn.dataset.bound === '1') return;

    refreshBtn.dataset.bound = '1';
    refreshBtn.addEventListener('click', async () => {
      const currentAid = Number(panel.dataset.aid);
      if (!Number.isFinite(currentAid)) return;
      await loadAndRenderAlbumPopularity(currentAid, panel, { forceRefresh: true });
    });
  }

  /**
   * 在相册页渲染“系列作品”面板
   * @param {number} currentAid
   */
  async function initAlbumSeriesPanel(currentAid, customKeyword = '', forceShow = false) {
    const existing = document.getElementById('wnacg-series-panel');
    if (existing) existing.remove();

    const currentTitle = extractCurrentAlbumTitle();
    const seriesKeyword = String(customKeyword || extractSeriesKeyword(currentTitle)).trim();
    if (!seriesKeyword && !forceShow) {
      log('未检测到系列关键词，跳过系列作品面板');
      return;
    }

    const panel = document.createElement('div');
    panel.id = 'wnacg-series-panel';
    panel.className = 'wnacg-series-panel';

    const titleEl = document.createElement('div');
    titleEl.className = 'wnacg-series-title';
    titleEl.textContent = '系列作品';

    const keywordEl = document.createElement('span');
    keywordEl.className = 'wnacg-series-keyword';
    keywordEl.textContent = seriesKeyword || '未识别';
    titleEl.appendChild(keywordEl);

    const loadingEl = document.createElement('div');
    loadingEl.className = 'wnacg-series-loading';
    loadingEl.textContent = seriesKeyword ? '正在检索系列作品...' : '未识别到系列关键词，请使用“系列作品”按钮手动输入。';

    panel.appendChild(titleEl);
    panel.appendChild(loadingEl);

    const anchor = document.getElementById('wnacg-album-oneclick')
      || document.querySelector('a[href*="download-index-aid-"]');
    const host = anchor?.closest('.download_btns, .ads, .asTB') || anchor?.parentElement || document.body;
    if (host && host.parentElement) {
      host.insertAdjacentElement('afterend', panel);
    } else {
      document.body.insertBefore(panel, document.body.firstChild);
    }

    if (!seriesKeyword) return;

    try {
      const searchUrl = `${location.origin}/search/index.php?q=${encodeURIComponent(seriesKeyword)}`;
      const searchDoc = await fetchHtmlDocument(searchUrl);
      if (!searchDoc) {
        loadingEl.textContent = '检索失败：请点击“系列作品”按钮手动重试。';
        return;
      }

      const normalizedKeyword = normalizeSeriesText(seriesKeyword);
      const isCjkKeyword = /[\u3400-\u9fff]/.test(normalizedKeyword);
      const minLen = isCjkKeyword ? 2 : 3;

      if (!normalizedKeyword || normalizedKeyword.length < minLen) {
        loadingEl.textContent = '关键词过短，无法稳定识别。请手动输入更精确关键词。';
        return;
      }

      const items = collectAlbumEntriesFromDoc(searchDoc, 120)
        .filter((item) => item.aid !== currentAid)
        .filter((item) => normalizeSeriesText(item.title).includes(normalizedKeyword))
        .slice(0, 16);

      if (items.length === 0) {
        loadingEl.textContent = '未找到同系列作品。可点击“系列作品”按钮手动更换关键词。';
        return;
      }

      const list = document.createElement('ul');
      list.className = 'wnacg-series-list';

      for (const item of items) {
        const li = document.createElement('li');
        li.className = 'wnacg-series-item';

        const a = document.createElement('a');
        a.href = item.url;
        a.textContent = item.title || `相册 ${item.aid}`;
        a.target = '_self';

        li.appendChild(a);
        list.appendChild(li);
      }

      const loading = panel.querySelector('.wnacg-series-loading');
      if (loading) loading.remove();
      panel.appendChild(list);
      log(`系列作品面板加载完成，共 ${items.length} 项`);
    } catch (error) {
      log(`加载系列作品失败: ${error.message}`, 'warn');
      loadingEl.textContent = `加载失败：${error.message}`;
    }
  }

  /**
   * 追加日志到进度面板
   * @param {string} message
   */
  function appendPanelLog(message) {
    if (!STATE.ui.logBox) return;
    const line = document.createElement('div');
    line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    STATE.ui.logBox.appendChild(line);
    STATE.ui.logBox.scrollTop = STATE.ui.logBox.scrollHeight;
  }

  /**
   * 创建/获取进度面板
   */
  function ensureProgressPanel() {
    if (STATE.ui.progressPanel) return;

    const panel = document.createElement('div');
    panel.className = 'wnacg-progress-panel';
    panel.id = 'wnacg-progress-panel';

    const title = document.createElement('div');
    title.className = 'wnacg-progress-title';
    title.textContent = 'WNACG 批量下载';

    const bar = document.createElement('div');
    bar.className = 'wnacg-progress-bar';
    const fill = document.createElement('div');
    fill.className = 'wnacg-progress-fill';
    fill.style.width = '0%';
    bar.appendChild(fill);

    const text = document.createElement('div');
    text.className = 'wnacg-progress-text';
    text.textContent = '0/0';

    const logBox = document.createElement('div');
    logBox.className = 'wnacg-progress-log';

    const actions = document.createElement('div');
    actions.className = 'wnacg-progress-actions';

    const pauseBtn = document.createElement('button');
    pauseBtn.className = 'wnacg-batch-btn';
    pauseBtn.textContent = '暂停';

    const clearQueueBtn = document.createElement('button');
    clearQueueBtn.className = 'wnacg-batch-btn';
    clearQueueBtn.textContent = '清空队列';

    const minimizeBtn = document.createElement('button');
    minimizeBtn.className = 'wnacg-batch-btn';
    minimizeBtn.textContent = '最小化';

    actions.appendChild(pauseBtn);
    actions.appendChild(clearQueueBtn);
    actions.appendChild(minimizeBtn);

    panel.appendChild(title);
    panel.appendChild(bar);
    panel.appendChild(text);
    panel.appendChild(logBox);
    panel.appendChild(actions);

    document.body.appendChild(panel);

    pauseBtn.addEventListener('click', async () => {
      const queue = STATE.activeQueue;
      if (!queue) return;
      if (queue.isPaused) {
        pauseBtn.disabled = true;
        try {
          await queue.resume();
          pauseBtn.textContent = '暂停';
        } finally {
          pauseBtn.disabled = false;
        }
      } else {
        queue.pause();
        pauseBtn.textContent = '继续';
      }
    });

    minimizeBtn.addEventListener('click', () => {
      STATE.ui.minimized = !STATE.ui.minimized;
      const hide = STATE.ui.minimized;
      bar.style.display = hide ? 'none' : '';
      text.style.display = hide ? 'none' : '';
      logBox.style.display = hide ? 'none' : '';
      pauseBtn.style.display = hide ? 'none' : '';
      clearQueueBtn.style.display = hide ? 'none' : '';
      minimizeBtn.textContent = hide ? '展开' : '最小化';
    });

    clearQueueBtn.addEventListener('click', () => {
      const queue = STATE.activeQueue;
      if (!queue) {
        appendPanelLog('当前没有可清空的下载队列');
        return;
      }

      const cleared = queue.clear();
      STATE.activeQueue = null;
      pauseBtn.textContent = '暂停';
      pauseBtn.disabled = false;
      updateProgressPanel(0, 0, '队列已清空');
      appendPanelLog(`已清空下载队列，移除 ${cleared} 个待下载任务`);
    });

    STATE.ui.progressPanel = panel;
    STATE.ui.progressFill = fill;
    STATE.ui.progressText = text;
    STATE.ui.logBox = logBox;
    STATE.ui.pauseBtn = pauseBtn;
    STATE.ui.clearQueueBtn = clearQueueBtn;
  }

  /**
   * 更新进度面板
   * @param {number} current
   * @param {number} total
   * @param {string} filename
   */
  function updateProgressPanel(current, total, filename) {
    ensureProgressPanel();
    if (!STATE.ui.progressFill || !STATE.ui.progressText) return;
    const percent = total > 0 ? Math.round((current / total) * 100) : 0;
    STATE.ui.progressFill.style.width = `${percent}%`;
    STATE.ui.progressText.textContent = `${current}/${total} ${filename ? `- ${filename}` : ''}`;
  }

  /**
   * 创建新的下载队列并绑定进度面板
   */
  function createDownloadQueue() {
    ensureProgressPanel();
    if (STATE.ui.logBox) STATE.ui.logBox.textContent = '';
    updateProgressPanel(0, 0, '');
    if (STATE.ui.pauseBtn) {
      STATE.ui.pauseBtn.textContent = '暂停';
      STATE.ui.pauseBtn.disabled = false;
    }

    const queue = new DownloadQueue({ delayBetweenTasks: 3000, maxRetries: 2 });
    STATE.activeQueue = queue;

    queue.on('progress', (data) => {
      updateProgressPanel(data.current, data.total, data.filename);
      appendPanelLog(`完成 ${data.current}/${data.total}: ${data.filename}`);
    });
    queue.on('completed', (data) => {
      updateProgressPanel(data.total, data.total, '全部完成');
      appendPanelLog(`完成：总计 ${data.total}，成功 ${data.successful}，失败 ${data.failed}`);
      STATE.activeQueue = null;
      if (STATE.ui.pauseBtn) {
        STATE.ui.pauseBtn.textContent = '暂停';
        STATE.ui.pauseBtn.disabled = false;
      }
    });
    queue.on('error', (data) => {
      appendPanelLog(`错误 aid=${data.aid}: ${data.message} (重试 ${data.retryCount})`);
    });

    return queue;
  }

  /**
   * 更新书架已选数量
   */
  function updateShelfSelectedCount() {
    const el = document.getElementById('wnacg-shelf-selected-count');
    if (!el) return;
    const selected = Array.from(document.querySelectorAll('input.wnacg-shelf-checkbox')).filter((cb) => cb.checked).length;
    el.textContent = `已选 ${selected}`;
  }

  // ============ 页面初始化逻辑 ============

  /**
   * 初始化书架页（SHELF）
   * 在此添加书架页特定的 DOM 操作、事件监听等
   */
  function initShelfPage() {
    log('初始化书架页...');

    try {
      const items = findShelfAlbumAnchors(document);
      if (items.length === 0) {
        log('未在当前页面找到书架相册条目链接', 'warn');
        return;
      }

      // 注入工具栏（防止重复注入）
      if (!document.getElementById('wnacg-batch-toolbar')) {
        const toolbar = document.createElement('div');
        toolbar.id = 'wnacg-batch-toolbar';
        toolbar.className = 'wnacg-shelf-toolbar';

        const btnSelectAll = document.createElement('button');
        btnSelectAll.className = 'wnacg-batch-btn';
        btnSelectAll.textContent = '全选';

        const btnInvert = document.createElement('button');
        btnInvert.className = 'wnacg-batch-btn';
        btnInvert.textContent = '反选';

        const btnBatchDownload = document.createElement('button');
        btnBatchDownload.className = 'wnacg-batch-btn';
        btnBatchDownload.textContent = '批量下载';

        const includeAllPagesLabel = document.createElement('label');
        const includeAllPages = document.createElement('input');
        includeAllPages.type = 'checkbox';
        includeAllPages.id = 'wnacg-include-all-pages';
        includeAllPagesLabel.appendChild(includeAllPages);
        includeAllPagesLabel.appendChild(document.createTextNode('包含所有分页（谨慎）'));

        const count = document.createElement('div');
        count.className = 'wnacg-shelf-count';
        count.id = 'wnacg-shelf-selected-count';
        count.textContent = '已选 0';

        toolbar.appendChild(btnSelectAll);
        toolbar.appendChild(btnInvert);
        toolbar.appendChild(btnBatchDownload);
        toolbar.appendChild(includeAllPagesLabel);
        toolbar.appendChild(count);

        // 插入到第一条相册链接之前
        const firstAnchor = items[0].anchor;
        const insertBefore = firstAnchor.closest('div') || firstAnchor.parentElement;
        if (insertBefore && insertBefore.parentElement) {
          insertBefore.parentElement.insertBefore(toolbar, insertBefore);
        } else {
          document.body.insertBefore(toolbar, document.body.firstChild);
        }

        const getCheckboxes = () => Array.from(document.querySelectorAll('input.wnacg-shelf-checkbox'));

        btnSelectAll.addEventListener('click', () => {
          for (const cb of getCheckboxes()) cb.checked = true;
          updateShelfSelectedCount();
        });

        btnInvert.addEventListener('click', () => {
          for (const cb of getCheckboxes()) cb.checked = !cb.checked;
          updateShelfSelectedCount();
        });

        btnBatchDownload.addEventListener('click', async () => {
          btnBatchDownload.disabled = true;
          try {
            let aids;
            if (includeAllPages.checked) {
              aids = await collectAllShelfAids(50);
            } else {
              aids = getCheckboxes()
                .filter((cb) => cb.checked)
                .map((cb) => Number(cb.dataset.aid))
                .filter((x) => Number.isFinite(x));
              aids = Array.from(new Set(aids));
            }

            if (!aids || aids.length === 0) {
              alert('未选择任何相册');
              return;
            }

            if (aids.length > 50) {
              const ok = confirm(`将开始下载 ${aids.length} 个相册（可能触发限额/封禁）。确定继续？`);
              if (!ok) return;
            }

            log(`准备开始批量下载，共 ${aids.length} 个任务`);

            const queue = createDownloadQueue();
            appendPanelLog(`开始批量下载：${aids.length} 个任务`);

            for (const aid of aids) queue.addTask(aid);
            await queue.start();
          } finally {
            btnBatchDownload.disabled = false;
          }
        });

        updateShelfSelectedCount();
      }

      // 注入每条相册前的 checkbox（防止重复）
      for (const { aid, anchor } of items) {
        if (anchor.dataset.wnacgBatchInjected === '1') continue;
        anchor.dataset.wnacgBatchInjected = '1';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'wnacg-shelf-checkbox';
        checkbox.dataset.aid = String(aid);

        checkbox.addEventListener('change', updateShelfSelectedCount);

        anchor.insertAdjacentElement('beforebegin', checkbox);
      }

      updateShelfSelectedCount();

      log(`书架页初始化完成，共注入 ${items.length} 个 checkbox`);
    } catch (error) {
      log(`书架页初始化出错: ${error.message}`, 'error');
      console.error(error);
    }
  }

  /**
   * 从相册链接向上查找合适的画廊卡片容器
   * @param {HTMLAnchorElement} anchor
   * @returns {HTMLElement|null}
   */
  function getGalleryContainerFromAnchor(anchor) {
    if (!anchor || !anchor.closest) return null;

    const selectors = [
      'li.gallary_item',
      '.gallary_item',
      '.gallery-item',
      '.album-item',
      'li',
      'article',
      '.item'
    ];

    for (const selector of selectors) {
      const node = anchor.closest(selector);
      if (!node) continue;
      if (node === document.body || node === document.documentElement) continue;
      return node;
    }

    return anchor.parentElement;
  }

  /**
   * 收集画廊卡片（优先传统模板，失败时回退到“按链接推断容器”）
   * @returns {HTMLElement[]}
   */
  function findGalleryItems() {
    const strictItems = Array.from(document.querySelectorAll('li.gallary_item'));
    if (strictItems.length > 0) {
      for (const item of strictItems) {
        item.classList.add('wnacg-gallery-item');
      }
      return strictItems;
    }

    const albumAnchors = Array.from(document.querySelectorAll('a[href]'))
      .filter((a) => extractAidFromHref(a.getAttribute('href') || a.href));

    const items = [];
    const seenNodes = new Set();

    for (const anchor of albumAnchors) {
      const container = getGalleryContainerFromAnchor(anchor);
      if (!container || seenNodes.has(container)) continue;

      // 只保留像“相册卡片”的容器，避免把导航/分页误识别成卡片
      const hasAidLink = Boolean(
        container.querySelector('a[href*="photos-index-aid-"], a[href*="photos-slist-aid-"], a[href*="photos-slide-aid-"]')
      );
      const hasCoverImage = Boolean(container.querySelector('img'));
      if (!hasAidLink || !hasCoverImage) continue;

      container.classList.add('wnacg-gallery-item');
      seenNodes.add(container);
      items.push(container);
    }

    return items;
  }

  /**
   * 获取当前页面中指定 aid 的所有画廊 checkbox
   * @param {number} aid
   * @returns {HTMLInputElement[]}
   */
  function getGalleryCheckboxesByAid(aid) {
    const safeAid = String(Number(aid));
    return Array.from(document.querySelectorAll(`input.wnacg-gallery-checkbox[data-aid="${safeAid}"]`));
  }

  /**
   * 按 aid 同步所有重复卡片状态，避免同一相册多处出现时状态不一致
   * @param {number} aid
   * @param {boolean} selected
   */
  function setGalleryAidSelected(aid, selected) {
    const isSelected = Boolean(selected);
    const checkboxes = getGalleryCheckboxesByAid(aid);

    for (const cb of checkboxes) {
      cb.checked = isSelected;
      cb.closest('.wnacg-gallery-item')?.classList.toggle('wnacg-selected', isSelected);
    }

    if (isSelected) {
      addStoredAid(aid);
    } else {
      removeStoredAid(aid);
    }

    updateGallerySelectedCount();
  }

  /**
   * 切换画廊卡片的选中状态（复用函数）
   * @param {HTMLElement} li 卡片 li 元素
   * @param {HTMLInputElement} checkbox 对应的 checkbox
   * @param {number} aid 相册 ID
   * @param {boolean} [forceState] 强制设为选中/取消，省略则 toggle
   */
  function toggleGalleryItemSelection(li, checkbox, aid, forceState) {
    const isSelected = typeof forceState === 'boolean'
      ? forceState
      : !isAidStored(aid);
    setGalleryAidSelected(aid, isSelected);
  }

  /**
   * 更新画廊页已选数量
   */
  function updateGallerySelectedCount() {
    const el = document.getElementById('wnacg-gallery-selected-count');
    if (!el) return;
    const storedAids = getStoredAids();
    el.textContent = `已选 ${storedAids.length}`;
  }

  /**
   * 提取画廊卡片标题
   * @param {HTMLElement} li
   * @param {HTMLAnchorElement|null} link
   * @returns {string}
   */
  function extractGalleryItemTitle(li, link = null) {
    const anchor = link || li.querySelector('a[href*="photos-index-aid-"], a[href*="photos-slist-aid-"], a[href*="photos-slide-aid-"]');
    const candidates = [
      anchor?.getAttribute('title') || '',
      anchor?.querySelector('img')?.getAttribute('alt') || '',
      li.querySelector('img')?.getAttribute('alt') || '',
      li.querySelector('.title, .name, .caption, .info')?.textContent || '',
      anchor?.textContent || ''
    ];

    for (const raw of candidates) {
      const text = String(raw || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length < 2) continue;
      if (/^(?:詳情|详情|more|download|下载)$/i.test(text)) continue;
      return text;
    }
    return '';
  }

  /**
   * 获取卡片上的热度徽章元素
   * @param {HTMLElement} li
   * @returns {HTMLElement}
   */
  function ensureGalleryPopularityBadge(li) {
    let badge = li.querySelector('.wnacg-gallery-hot-badge');
    if (badge) return badge;

    badge = document.createElement('div');
    badge.className = 'wnacg-gallery-hot-badge wnacg-hot-loading';
    badge.textContent = '热度 ...';
    li.appendChild(badge);
    return badge;
  }

  /**
   * 渲染单卡片热度
   * @param {HTMLElement} li
   * @param {{score:number|null,tooltip?:string,loading?:boolean}} payload
   */
  function renderGalleryPopularityBadge(li, payload = {}) {
    const badge = ensureGalleryPopularityBadge(li);
    const score = payload.score;
    const loading = Boolean(payload.loading);

    if (loading) {
      badge.className = 'wnacg-gallery-hot-badge wnacg-hot-loading';
      badge.textContent = '热度 ...';
      badge.title = payload.tooltip || '正在计算热度...';
      return;
    }

    if (Number.isFinite(score)) {
      const grade = getPopularityGrade(score);
      badge.className = `wnacg-gallery-hot-badge ${grade.className}`;
      badge.textContent = `热度 ${Math.round(score * 100)}分`;
      badge.title = payload.tooltip || [
        `综合热度 ${Math.round(score * 100)}分`,
        `等级：${formatPopularityGradeLabel(grade)}`,
        getPopularityLegendText()
      ].join('\n');
      return;
    }

    badge.className = 'wnacg-gallery-hot-badge wnacg-hot-d';
    badge.textContent = '热度 N/A';
    badge.title = payload.tooltip || `暂无可用热度数据\n${getPopularityLegendText()}`;
  }

  /**
   * 清除当前画廊页热度标注
   */
  function clearGalleryPopularityBadges() {
    for (const badge of document.querySelectorAll('.wnacg-gallery-hot-badge')) {
      badge.remove();
    }
  }

  /**
   * 更新画廊“自动热度”按钮显示
   * @param {HTMLButtonElement|null} btn
   * @param {boolean} enabled
   * @param {boolean} running
   */
  function updateGalleryAutoButtonState(btn, enabled, running = false) {
    if (!btn) return;
    if (running) {
      btn.textContent = '自动热度：计算中';
      btn.title = '正在后台计算热度';
      btn.disabled = true;
      return;
    }

    btn.disabled = false;
    btn.textContent = enabled ? '自动热度：开' : '自动热度：关';
    btn.title = enabled ? '已开启：进入画廊会自动标注热度' : '已关闭：需要手动点击“刷新热度”';
  }

  /**
   * 页面不可见时等待可见（超时即放弃）
   * @param {number} timeoutMs
   * @returns {Promise<boolean>}
   */
  async function waitForDocumentVisible(timeoutMs = 7000) {
    if (!document.hidden) return true;
    return new Promise((resolve) => {
      let resolved = false;
      const finish = (ok) => {
        if (resolved) return;
        resolved = true;
        document.removeEventListener('visibilitychange', onChange);
        clearTimeout(timer);
        resolve(ok);
      };
      const onChange = () => {
        if (!document.hidden) finish(true);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      document.addEventListener('visibilitychange', onChange);
    });
  }

  /**
   * 浏览器空闲时执行任务（降级到定时器）
   * @param {Function} task
   * @param {number} timeoutMs
   */
  function runWhenBrowserIdle(task, timeoutMs = 4000) {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(() => task(), { timeout: timeoutMs });
      return;
    }
    setTimeout(() => task(), 600);
  }

  /**
   * 触发画廊热度计算（带并发保护）
   * @param {{forceRefresh?:boolean,source?:string}} options
   * @returns {Promise<number>}
   */
  async function triggerGalleryPopularityAnnotation(options = {}) {
    const enabled = getGalleryPopularityAutoEnabled();
    if (!enabled && options.source === 'auto') return 0;

    if (STATE.galleryPopularity.running) {
      STATE.galleryPopularity.queued = true;
      return 0;
    }

    STATE.galleryPopularity.running = true;
    updateGalleryAutoButtonState(STATE.ui.galleryAutoBtn, enabled, true);
    let markedCount = 0;

    const source = String(options.source || 'manual');
    const forceRefresh = Boolean(options.forceRefresh);
    const includeExternal = source === 'manual' || source === 'queued' || forceRefresh;
    const maxItems = source === 'auto' ? 36 : 120;

    try {
      markedCount = await annotateGalleryPopularity({ forceRefresh, includeExternal, maxItems });
      return markedCount;
    } finally {
      STATE.galleryPopularity.running = false;
      updateGalleryAutoButtonState(STATE.ui.galleryAutoBtn, getGalleryPopularityAutoEnabled(), false);

      if (STATE.galleryPopularity.queued) {
        STATE.galleryPopularity.queued = false;
        setTimeout(() => {
          void triggerGalleryPopularityAnnotation({ forceRefresh: false, source: 'queued' });
        }, 400);
      }
    }
  }

  /**
   * 计划自动热度标注（更人性化：可见 + 空闲后执行）
   * @param {{delayMs?:number,forceRefresh?:boolean}} options
   */
  function scheduleGalleryPopularityAutoRun(options = {}) {
    const delayMs = Number.isFinite(options.delayMs) ? Math.max(0, options.delayMs) : 800;
    const forceRefresh = Boolean(options.forceRefresh);

    setTimeout(async () => {
      if (!getGalleryPopularityAutoEnabled()) return;
      const visible = await waitForDocumentVisible(8000);
      if (!visible || !getGalleryPopularityAutoEnabled()) return;

      runWhenBrowserIdle(() => {
        void triggerGalleryPopularityAnnotation({ forceRefresh, source: 'auto' });
      }, 4500);
    }, delayMs);
  }

  /**
   * 收集当前页画廊卡片（按 aid 聚合）
   * @returns {Array<{aid:number,title:string,cards:HTMLElement[],firstIndex:number}>}
   */
  function collectGalleryAidRecords() {
    const items = findGalleryItems();
    const map = new Map();
    let index = 0;

    for (const li of items) {
      const link = li.querySelector('a[href*="photos-index-aid-"], a[href*="photos-slist-aid-"], a[href*="photos-slide-aid-"]');
      if (!link) continue;
      const aid = extractAidFromHref(link.getAttribute('href') || link.href || '');
      if (!aid) continue;

      li.dataset.wnacgPos = String(index);
      index += 1;

      li.dataset.aid = String(aid);
      const title = extractGalleryItemTitle(li, link);
      if (title) li.dataset.wnacgTitle = title;

      const prev = map.get(aid);
      if (!prev) {
        map.set(aid, { aid, title: title || '', cards: [li], firstIndex: Number(li.dataset.wnacgPos || 0) });
      } else {
        if (!prev.title && title) prev.title = title;
        prev.cards.push(li);
      }
    }

    return Array.from(map.values());
  }

  /**
   * 基于当前画廊页面位置估算热度（兜底，避免 N/A）
   * @param {number} firstIndex
   * @param {number} total
   * @returns {number|null}
   */
  function estimateGalleryPageScore(firstIndex, total) {
    if (!Number.isFinite(firstIndex) || !Number.isFinite(total) || total <= 0) return null;
    if (total === 1) return 0.7;
    const percentile = 1 - firstIndex / (total - 1);
    return 0.3 + percentile * 0.5; // 区间 [0.3, 0.8]
  }

  /**
   * 构建榜单 aid -> rank 查询表
   * @param {string} url
   * @returns {Promise<{url:string,listSize:number,rankMap:Map<number,number>}>}
   */
  async function buildAidRankLookup(url) {
    if (!url) return { url: '', listSize: 0, rankMap: new Map() };

    const aids = await collectRankedAidsFromPagedUrl(url, 4, 280);
    const rankMap = new Map();
    for (let i = 0; i < aids.length; i += 1) {
      if (!rankMap.has(aids[i])) rankMap.set(aids[i], i + 1);
    }

    return { url, listSize: aids.length, rankMap };
  }

  /**
   * 榜单查询表缓存读取
   * @param {string} cacheKey
   * @param {number} ttlMs
   * @returns {{url:string,listSize:number,rankMap:Map<number,number>}|null}
   */
  function getGalleryRankLookupCache(cacheKey, ttlMs = 20 * 60 * 1000) {
    const raw = readLocalJSON(GALLERY_RANK_LOOKUP_CACHE_KEY, {});
    const item = raw[cacheKey];
    if (!item || !Number.isFinite(item.ts)) return null;
    if (Date.now() - item.ts > ttlMs) return null;
    if (!Array.isArray(item.entries)) return null;

    const rankMap = new Map();
    for (const tuple of item.entries) {
      const aid = Number(tuple?.[0]);
      const rank = Number(tuple?.[1]);
      if (!Number.isFinite(aid) || !Number.isFinite(rank)) continue;
      rankMap.set(aid, rank);
    }

    return {
      url: String(item.url || ''),
      listSize: Number(item.listSize || rankMap.size),
      rankMap
    };
  }

  /**
   * 榜单查询表缓存写入
   * @param {string} cacheKey
   * @param {{url:string,listSize:number,rankMap:Map<number,number>}} lookup
   */
  function setGalleryRankLookupCache(cacheKey, lookup) {
    const raw = readLocalJSON(GALLERY_RANK_LOOKUP_CACHE_KEY, {});
    const entries = Array.from((lookup?.rankMap || new Map()).entries()).slice(0, 400);
    raw[cacheKey] = {
      ts: Date.now(),
      url: String(lookup?.url || ''),
      listSize: Number(lookup?.listSize || 0),
      entries
    };
    writeLocalJSON(GALLERY_RANK_LOOKUP_CACHE_KEY, raw);
  }

  /**
   * 带缓存的榜单查询表构建
   * @param {string} scopeName
   * @param {string} url
   * @param {{forceRefresh?:boolean}} options
   * @returns {Promise<{url:string,listSize:number,rankMap:Map<number,number>}>}
   */
  async function buildAidRankLookupCached(scopeName, url, options = {}) {
    if (!url) return { url: '', listSize: 0, rankMap: new Map() };
    const forceRefresh = Boolean(options.forceRefresh);
    const cacheKey = `${location.host}::${scopeName}::${url}`;

    if (!forceRefresh) {
      const cached = getGalleryRankLookupCache(cacheKey, 20 * 60 * 1000);
      if (cached) return cached;
    }

    const lookup = await buildAidRankLookup(url);
    setGalleryRankLookupCache(cacheKey, lookup);
    return lookup;
  }

  /**
   * 从查询表中读取某 aid 的排名信息
   * @param {{url:string,listSize:number,rankMap:Map<number,number>}} lookup
   * @param {number} aid
   * @returns {{url:string,rank:number|null,listSize:number,score:number|null}}
   */
  function getAidRankFromLookup(lookup, aid) {
    if (!lookup?.url) return { url: '', rank: null, listSize: 0, score: null };
    const rank = lookup.rankMap.get(aid) || null;
    if (!Number.isFinite(rank)) {
      return { url: lookup.url, rank: null, listSize: lookup.listSize || 0, score: null };
    }
    return {
      url: lookup.url,
      rank,
      listSize: lookup.listSize || 0,
      score: getRankPercentileScore(rank, lookup.listSize || 0)
    };
  }

  /**
   * 简要输出排名状态
   * @param {{rank:number|null,listSize:number}} scope
   * @returns {string}
   */
  function formatShortScopeRank(scope) {
    if (!scope || !scope.listSize) return '无数据';
    if (Number.isFinite(scope.rank)) return `#${scope.rank}/${scope.listSize}`;
    return `未上榜(${scope.listSize})`;
  }

  /**
   * 仅用缓存结果为画廊卡片补热度徽章
   */
  function applyGalleryPopularityBadgesFromCache() {
    const records = collectGalleryAidRecords();
    for (const record of records) {
      const cache = getPopularityCache(`${location.host}::${record.aid}`);
      if (!cache || !Number.isFinite(cache.finalScore)) continue;
      const grade = getPopularityGrade(cache.finalScore);
      for (const li of record.cards) {
        renderGalleryPopularityBadge(li, {
          score: cache.finalScore,
          tooltip: [
            `缓存热度 ${Math.round(cache.finalScore * 100)}分`,
            `等级：${formatPopularityGradeLabel(grade)}`,
            getPopularityLegendText()
          ].join('\n')
        });
      }
    }
  }

  /**
   * 为当前画廊页批量计算并标注热度
   * @param {{forceRefresh?:boolean,includeExternal?:boolean,maxItems?:number}} options
   * @returns {Promise<number>} 标注的 aid 数
   */
  async function annotateGalleryPopularity(options = {}) {
    const forceRefresh = Boolean(options.forceRefresh);
    const includeExternal = Boolean(options.includeExternal);
    const allRecords = collectGalleryAidRecords();
    if (allRecords.length === 0) return 0;

    const maxItems = Number.isFinite(options.maxItems)
      ? Math.max(1, Math.min(Number(options.maxItems), 200))
      : 80;
    const records = allRecords.slice(0, maxItems);

    let uncachedCount = 0;
    for (const record of records) {
      const cacheKey = `${location.host}::${record.aid}`;
      const cached = forceRefresh ? null : getPopularityCache(cacheKey);
      if (cached && Number.isFinite(cached.finalScore)) {
        const grade = getPopularityGrade(cached.finalScore);
        record._cached = cached;
        for (const li of record.cards) {
          renderGalleryPopularityBadge(li, {
            score: cached.finalScore,
            tooltip: [
              `缓存热度 ${Math.round(cached.finalScore * 100)}分`,
              `等级：${formatPopularityGradeLabel(grade)}`,
              getPopularityLegendText()
            ].join('\n')
          });
        }
        continue;
      }

      uncachedCount += 1;
      const pageScore = estimateGalleryPageScore(record.firstIndex, records.length);
      record._pageScore = pageScore;
      for (const li of record.cards) {
        if (Number.isFinite(pageScore)) {
          renderGalleryPopularityBadge(li, {
            score: pageScore,
            tooltip: `当前页预估热度 ${Math.round(pageScore * 100)}（后台计算中）`
          });
        } else {
          renderGalleryPopularityBadge(li, { loading: true });
        }
      }
    }

    if (uncachedCount === 0) return records.length;

    const rankUrls = await discoverPopularityRankUrls();
    const [dayLookup, weekLookup, monthLookup] = await Promise.all([
      buildAidRankLookupCached('day', rankUrls.day, { forceRefresh }),
      buildAidRankLookupCached('week', rankUrls.week, { forceRefresh }),
      buildAidRankLookupCached('month', rankUrls.month, { forceRefresh })
    ]);

    let ehDay = { items: [] };
    let ehMonth = { items: [] };
    let ehAll = { items: [] };
    let dlWeek = { items: [] };
    let dlMonth = { items: [] };
    let dlAll = { items: [] };
    if (includeExternal) {
      [ehDay, ehMonth, ehAll, dlWeek, dlMonth, dlAll] = await Promise.all([
        fetchEHToplistScope('day'),
        fetchEHToplistScope('month'),
        fetchEHToplistScope('all'),
        fetchDLsiteRankingScope('week'),
        fetchDLsiteRankingScope('month'),
        fetchDLsiteRankingScope('all')
      ]);
    }

    for (let i = 0; i < records.length; i += 1) {
      const record = records[i];
      if (!forceRefresh && record._cached) continue;

      const day = getAidRankFromLookup(dayLookup, record.aid);
      const week = getAidRankFromLookup(weekLookup, record.aid);
      const month = getAidRankFromLookup(monthLookup, record.aid);
      const wnacgScore = weightedAverage([
        { value: day.score, weight: 0.5 },
        { value: week.score, weight: 0.3 },
        { value: month.score, weight: 0.2 }
      ]);

      let ehDayMatch = { rank: null, listSize: 0, score: null };
      let ehMonthMatch = { rank: null, listSize: 0, score: null };
      let ehAllMatch = { rank: null, listSize: 0, score: null };
      let dlWeekMatch = { rank: null, listSize: 0, score: null };
      let dlMonthMatch = { rank: null, listSize: 0, score: null };
      let dlAllMatch = { rank: null, listSize: 0, score: null };
      let ehScore = null;
      let dlScore = null;

      if (includeExternal && record.title) {
        const titleCandidates = buildPopularityTitleCandidates(record.title);
        if (titleCandidates.length > 0) {
          ehDayMatch = matchTargetInRankedTitles(titleCandidates, ehDay.items);
          ehMonthMatch = matchTargetInRankedTitles(titleCandidates, ehMonth.items);
          ehAllMatch = matchTargetInRankedTitles(titleCandidates, ehAll.items);
          ehScore = weightedAverage([
            { value: ehDayMatch.score, weight: 0.45 },
            { value: ehMonthMatch.score, weight: 0.35 },
            { value: ehAllMatch.score, weight: 0.2 }
          ]);

          dlWeekMatch = matchTargetInRankedTitles(titleCandidates, dlWeek.items);
          dlMonthMatch = matchTargetInRankedTitles(titleCandidates, dlMonth.items);
          dlAllMatch = matchTargetInRankedTitles(titleCandidates, dlAll.items);
          dlScore = weightedAverage([
            { value: dlWeekMatch.score, weight: 0.4 },
            { value: dlMonthMatch.score, weight: 0.35 },
            { value: dlAllMatch.score, weight: 0.25 }
          ]);
        }
      }

      const baseScore = weightedAverage([
        { value: wnacgScore, weight: 0.78 },
        { value: ehScore, weight: 0.16 },
        { value: dlScore, weight: 0.06 }
      ]);

      const pageScore = Number.isFinite(record._pageScore)
        ? record._pageScore
        : estimateGalleryPageScore(record.firstIndex, records.length);
      const finalScore = Number.isFinite(baseScore)
        ? weightedAverage([
            { value: baseScore, weight: 0.88 },
            { value: pageScore, weight: 0.12 }
          ])
        : pageScore;
      const stableScore = Number.isFinite(finalScore) ? finalScore : (Number.isFinite(pageScore) ? pageScore : 0.35);
      const grade = getPopularityGrade(stableScore);

      const tooltipLines = [
        `WNACG 日:${formatShortScopeRank(day)} 周:${formatShortScopeRank(week)} 月:${formatShortScopeRank(month)}`,
        includeExternal
          ? `EH 日:${formatShortScopeRank(ehDayMatch)} 月:${formatShortScopeRank(ehMonthMatch)} 总:${formatShortScopeRank(ehAllMatch)}`
          : 'EH：自动模式未查询（手动刷新可补全）',
        includeExternal
          ? `DL 周:${formatShortScopeRank(dlWeekMatch)} 月:${formatShortScopeRank(dlMonthMatch)} 总:${formatShortScopeRank(dlAllMatch)}`
          : 'DL：自动模式未查询（手动刷新可补全）',
        `页内估算: ${Number.isFinite(pageScore) ? Math.round(pageScore * 100) : 'N/A'}`,
        `综合: ${Math.round(stableScore * 100)}分`,
        `等级: ${formatPopularityGradeLabel(grade)}`,
        `说明: ${getPopularityLegendText()}`
      ];

      for (const li of record.cards) {
        renderGalleryPopularityBadge(li, {
          score: stableScore,
          tooltip: tooltipLines.join('\n')
        });
      }

      const cacheKey = `${location.host}::${record.aid}`;
      setPopularityCache(cacheKey, {
        aid: record.aid,
        computedAt: Date.now(),
        finalScore: stableScore,
        grade
      });

      if (i % 8 === 7) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    return records.length;
  }

  /**
   * 初始化画廊页（GALLERY）
   * 首页/更新/分类/排行/搜索页面的批量勾选下载
   */
  function initGalleryPage() {
    log('初始化画廊页...');

    try {
      // 收集画廊卡片（兼容不同模板）
      const galleryItems = findGalleryItems();
      if (galleryItems.length === 0) {
        log('未在当前页面找到画廊卡片', 'warn');
        return;
      }

      // 注入工具栏（防止重复注入）
      if (!document.getElementById('wnacg-gallery-toolbar')) {
        const toolbar = document.createElement('div');
        toolbar.id = 'wnacg-gallery-toolbar';
        toolbar.className = 'wnacg-gallery-toolbar';

        const btnSelectMode = document.createElement('button');
        btnSelectMode.className = 'wnacg-batch-btn';
        btnSelectMode.textContent = '进入选择模式';

        const btnExitSelectMode = document.createElement('button');
        btnExitSelectMode.className = 'wnacg-batch-btn wnacg-exit-mode-btn';
        btnExitSelectMode.textContent = '退出选择模式';

        const btnClearSelection = document.createElement('button');
        btnClearSelection.className = 'wnacg-batch-btn';
        btnClearSelection.textContent = '清空选择';

        const btnSelectAll = document.createElement('button');
        btnSelectAll.className = 'wnacg-batch-btn';
        btnSelectAll.textContent = '全选';

        const btnInvert = document.createElement('button');
        btnInvert.className = 'wnacg-batch-btn';
        btnInvert.textContent = '反选';

        const btnBatchDownload = document.createElement('button');
        btnBatchDownload.className = 'wnacg-batch-btn';
        btnBatchDownload.textContent = '批量下载';

        const btnMarkPopularity = document.createElement('button');
        btnMarkPopularity.className = 'wnacg-batch-btn';
        btnMarkPopularity.textContent = '刷新热度';

        const btnClearPopularity = document.createElement('button');
        btnClearPopularity.className = 'wnacg-batch-btn';
        btnClearPopularity.textContent = '清除热度';

        const btnAutoPopularity = document.createElement('button');
        btnAutoPopularity.className = 'wnacg-batch-btn';
        btnAutoPopularity.textContent = '自动热度：开';

        const popularityLegend = document.createElement('div');
        popularityLegend.className = 'wnacg-gallery-hot-legend';
        popularityLegend.textContent = `热度说明：${getPopularityLegendText()}`;

        const count = document.createElement('div');
        count.className = 'wnacg-gallery-count';
        count.id = 'wnacg-gallery-selected-count';
        count.textContent = '已选 0';

        const modeIndicator = document.createElement('div');
        modeIndicator.className = 'wnacg-gallery-mode-indicator';
        modeIndicator.textContent = '普通模式：点击封面进入相册';

        toolbar.appendChild(btnSelectMode);
        toolbar.appendChild(btnExitSelectMode);
        toolbar.appendChild(btnClearSelection);
        toolbar.appendChild(btnSelectAll);
        toolbar.appendChild(btnInvert);
        toolbar.appendChild(btnBatchDownload);
        toolbar.appendChild(btnMarkPopularity);
        toolbar.appendChild(btnClearPopularity);
        toolbar.appendChild(btnAutoPopularity);
        toolbar.appendChild(popularityLegend);
        toolbar.appendChild(modeIndicator);
        toolbar.appendChild(count);

        // 插入到第一个画廊区块之前（无 gallary_wrap 时回退到第一张卡片）
        const firstWrap = document.querySelector('div.gallary_wrap') || galleryItems[0];
        if (firstWrap && firstWrap.parentElement) {
          firstWrap.parentElement.insertBefore(toolbar, firstWrap);
        } else {
          const header = document.getElementById('header');
          if (header && header.nextSibling) {
            header.parentElement.insertBefore(toolbar, header.nextSibling);
          } else {
            document.body.insertBefore(toolbar, document.body.firstChild);
          }
        }

        // 移动端：给 body 加 class 防止工具栏遮挡内容
        if (IS_MOBILE) {
          document.body.classList.add('wnacg-mobile-has-toolbar');
        }

        const getCheckboxes = () => Array.from(document.querySelectorAll('input.wnacg-gallery-checkbox'));

        const applySelectMode = (enabled) => {
          STATE.selectMode = Boolean(enabled);
          setStoredSelectMode(STATE.selectMode);
          btnSelectMode.classList.toggle('wnacg-select-mode-active', STATE.selectMode);
          btnSelectMode.textContent = STATE.selectMode ? '选择模式已开启' : '进入选择模式';
          btnExitSelectMode.style.display = STATE.selectMode ? '' : 'none';
          modeIndicator.classList.toggle('wnacg-active', STATE.selectMode);
          modeIndicator.textContent = STATE.selectMode
            ? '选择模式已开启：点击封面可勾选'
            : '普通模式：点击封面进入相册';
          document.body.classList.toggle('wnacg-select-mode', STATE.selectMode);
        };
        // 存到 STATE 以便 card loop 中长按也能调用
        STATE.applySelectMode = applySelectMode;

        btnSelectMode.addEventListener('click', () => {
          applySelectMode(!STATE.selectMode);
        });

        btnExitSelectMode.addEventListener('click', () => {
          applySelectMode(false);
        });

        btnClearSelection.addEventListener('click', () => {
          clearStoredAids();
          for (const cb of getCheckboxes()) cb.checked = false;
          for (const li of document.querySelectorAll('.wnacg-gallery-item.wnacg-selected')) {
            li.classList.remove('wnacg-selected');
          }
          updateGallerySelectedCount();
        });

        btnSelectAll.addEventListener('click', () => {
          const aids = Array.from(new Set(
            getCheckboxes()
              .map((cb) => Number(cb.dataset.aid))
              .filter((x) => Number.isFinite(x))
          ));
          for (const aid of aids) setGalleryAidSelected(aid, true);
        });

        btnInvert.addEventListener('click', () => {
          const aids = Array.from(new Set(
            getCheckboxes()
              .map((cb) => Number(cb.dataset.aid))
              .filter((x) => Number.isFinite(x))
          ));
          for (const aid of aids) {
            setGalleryAidSelected(aid, !isAidStored(aid));
          }
        });

        btnBatchDownload.addEventListener('click', async () => {
          btnBatchDownload.disabled = true;
          try {
            const checkboxAids = getCheckboxes()
              .filter((cb) => cb.checked)
              .map((cb) => Number(cb.dataset.aid))
              .filter((x) => Number.isFinite(x));
            const storedAids = getStoredAids();
            const uniqueAids = Array.from(new Set([...storedAids, ...checkboxAids]));

            if (uniqueAids.length === 0) {
              alert('未选择任何相册');
              return;
            }

            if (uniqueAids.length > 50) {
              const ok = confirm(`将开始下载 ${uniqueAids.length} 个相册。确定继续？`);
              if (!ok) return;
            }

            log(`准备开始批量下载，共 ${uniqueAids.length} 个任务`);

            const queue = createDownloadQueue();
            appendPanelLog(`开始批量下载：${uniqueAids.length} 个任务`);

            for (const aid of uniqueAids) queue.addTask(aid);
            await queue.start();

            // 下载完成后清空选择
            clearStoredAids();
            for (const cb of getCheckboxes()) cb.checked = false;
            for (const li of document.querySelectorAll('.wnacg-gallery-item.wnacg-selected')) {
              li.classList.remove('wnacg-selected');
            }
            updateGallerySelectedCount();
          } finally {
            btnBatchDownload.disabled = false;
          }
        });

        btnMarkPopularity.addEventListener('click', async () => {
          if (btnMarkPopularity.disabled) return;
          btnMarkPopularity.disabled = true;
          btnClearPopularity.disabled = true;
          const oldText = btnMarkPopularity.textContent;
          btnMarkPopularity.textContent = '刷新中...';
          try {
            const markedCount = await triggerGalleryPopularityAnnotation({ forceRefresh: true, source: 'manual' });
            log(`画廊热度刷新完成，共 ${markedCount} 个相册`);
          } finally {
            btnMarkPopularity.disabled = false;
            btnClearPopularity.disabled = false;
            btnMarkPopularity.textContent = oldText;
          }
        });

        btnClearPopularity.addEventListener('click', () => {
          clearGalleryPopularityBadges();
        });

        btnAutoPopularity.addEventListener('click', () => {
          const enabled = !getGalleryPopularityAutoEnabled();
          setGalleryPopularityAutoEnabled(enabled);
          updateGalleryAutoButtonState(btnAutoPopularity, enabled, false);

          if (enabled) {
            scheduleGalleryPopularityAutoRun({ delayMs: 350, forceRefresh: false });
          }
        });

        applySelectMode(getStoredSelectMode());
        updateGallerySelectedCount();
        STATE.ui.galleryAutoBtn = btnAutoPopularity;
        updateGalleryAutoButtonState(btnAutoPopularity, getGalleryPopularityAutoEnabled(), false);
      }

      // 注入每个画廊卡片的 checkbox
      let injectedCount = 0;
      for (const li of galleryItems) {
        if (li.dataset.wnacgGalleryInjected === '1') continue;
        li.classList.add('wnacg-gallery-item');

        // 从卡片内链接提取 aid
        const link = li.querySelector(
          'a[href*="photos-index-aid-"], a[href*="photos-slist-aid-"], a[href*="photos-slide-aid-"]'
        );
        if (!link) continue; // 跳过无法提取 aid 的卡片（可能是广告）

        const aid = extractAidFromHref(link.getAttribute('href'));
        if (!aid) continue;

        li.dataset.wnacgGalleryInjected = '1';
        li.dataset.aid = String(aid);
        const itemTitle = extractGalleryItemTitle(li, link);
        if (itemTitle) li.dataset.wnacgTitle = itemTitle;

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'wnacg-gallery-checkbox';
        checkbox.dataset.aid = String(aid);

        // stopPropagation 防止点击 checkbox 触发链接跳转
        checkbox.addEventListener('click', (e) => {
          e.stopPropagation();
        });
        checkbox.addEventListener('change', () => {
          setGalleryAidSelected(aid, checkbox.checked);
        });

        // 卡片交互：选择模式下点击 toggle + 移动端长按进入选择模式
        const interactionTarget = li.querySelector('div.pic_box, .pic_box') || link;
        if (interactionTarget) {
          // 移动端：添加长按目标 CSS class
          if (IS_MOBILE) {
            interactionTarget.classList.add('wnacg-longpress-target');
          }

          // 长按状态（per-target）
          let longPressTriggered = false;
          let pressTimer = null;
          let pressStart = null;
          const LONG_PRESS_MS = 350;
          const MOVE_THRESHOLD = 10;

          function clearPressTimer() {
            if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
            pressStart = null;
          }

          // Pointer Events 长按（仅移动端触控/笔）
          interactionTarget.addEventListener('pointerdown', (e) => {
            if (!IS_MOBILE) return;
            if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
            longPressTriggered = false;
            pressStart = { x: e.clientX, y: e.clientY };
            clearPressTimer();
            pressTimer = setTimeout(() => {
              longPressTriggered = true;
              // 自动进入选择模式 + 选中当前卡片
              if (!STATE.selectMode && STATE.applySelectMode) STATE.applySelectMode(true);
              toggleGalleryItemSelection(li, checkbox, aid);
            }, LONG_PRESS_MS);
          });

          interactionTarget.addEventListener('pointermove', (e) => {
            if (!pressStart) return;
            if (Math.abs(e.clientX - pressStart.x) > MOVE_THRESHOLD ||
                Math.abs(e.clientY - pressStart.y) > MOVE_THRESHOLD) {
              clearPressTimer();
            }
          });

          ['pointerup', 'pointercancel'].forEach(evt =>
            interactionTarget.addEventListener(evt, () => { clearPressTimer(); })
          );

          // 阻止移动端长按原生 context menu
          interactionTarget.addEventListener('contextmenu', (e) => {
            if (IS_MOBILE) e.preventDefault();
          });

          // flag+click 模式：阻止长按后 / 选择模式下的导航跳转
          const picLink = link;
          if (picLink) {
            picLink.addEventListener('click', (e) => {
              if (longPressTriggered) {
                e.preventDefault();
                e.stopPropagation();
                longPressTriggered = false;
                return;
              }
              if (STATE.selectMode) {
                e.preventDefault();
                e.stopPropagation();
                toggleGalleryItemSelection(li, checkbox, aid);
              }
            }, true); // capture phase
          }
        } // end if (interactionTarget)

        li.appendChild(checkbox);

        // 从 sessionStorage 恢复已选状态
        if (isAidStored(aid)) {
          setGalleryAidSelected(aid, true);
        }

        injectedCount++;
      }

      updateGallerySelectedCount();
      applyGalleryPopularityBadgesFromCache();
      if (getGalleryPopularityAutoEnabled()) {
        scheduleGalleryPopularityAutoRun({ delayMs: 900, forceRefresh: false });
      }

      log(`画廊页初始化完成，共注入 ${injectedCount} 个 checkbox`);
    } catch (error) {
      log(`画廊页初始化出错: ${error.message}`, 'error');
      console.error(error);
    }
  }

  /**
   * 确保相册页“系列作品”手动检索按钮存在
   * @param {number} aid
   * @param {HTMLElement|null} referenceEl
   * @param {string} baseClassName
   */
  function ensureAlbumSeriesButton(aid, referenceEl, baseClassName = '') {
    if (document.getElementById('wnacg-album-series-find')) return;

    const classSet = new Set(['btn', 'wnacg-album-series-btn']);
    for (const name of String(baseClassName || '').split(/\s+/)) {
      if (name) classSet.add(name);
    }

    const findBtn = document.createElement('a');
    findBtn.id = 'wnacg-album-series-find';
    findBtn.className = Array.from(classSet).join(' ');
    findBtn.href = 'javascript:void(0)';
    findBtn.textContent = '系列作品';

    if (referenceEl && referenceEl.parentElement) {
      referenceEl.insertAdjacentElement('afterend', findBtn);
    } else {
      document.body.insertBefore(findBtn, document.body.firstChild);
    }

    findBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      const title = extractCurrentAlbumTitle();
      const suggested = extractSeriesKeyword(title) || deriveSeriesKeywordSuggestion(title);
      const input = window.prompt('请输入系列关键词（例如：秘密教學）', suggested || '');
      if (input === null) return;
      const keyword = String(input).trim();
      if (!keyword) {
        alert('关键词不能为空');
        return;
      }
      await initAlbumSeriesPanel(aid, keyword, true);
    });
  }

  /**
   * 在此添加相册页特定的 DOM 操作、事件监听等
   */
  function initAlbumPage() {
    log('初始化相册页...');

    try {
      const aid = extractAidFromLocation();
      if (!aid) {
        log('未能从相册页 URL 提取 aid', 'warn');
        return;
      }

      if (document.getElementById('wnacg-album-oneclick')) {
        log('相册页一键下载按钮已存在，跳过注入');
        const oneClickExisting = document.getElementById('wnacg-album-oneclick');
        const popularityPanel = ensureAlbumPopularityPanel(oneClickExisting);
        bindAlbumPopularityRefresh(popularityPanel, aid);
        loadAndRenderAlbumPopularity(aid, popularityPanel, { forceRefresh: false });
        ensureAlbumSeriesButton(aid, oneClickExisting, oneClickExisting?.className || 'btn');
        initAlbumSeriesPanel(aid);
        return;
      }

      const downloadBtn = document.querySelector('a.btn[href*="download-index-aid-"], a[href*="download-index-aid-"]');
      const oneClick = document.createElement('a');
      oneClick.id = 'wnacg-album-oneclick';
      const classSet = new Set(['btn', 'wnacg-album-oneclick-btn']);
      for (const name of String(downloadBtn?.className || '').split(/\s+/)) {
        if (name) classSet.add(name);
      }
      oneClick.className = Array.from(classSet).join(' ');
      oneClick.href = 'javascript:void(0)';
      oneClick.textContent = '一键下载';

      if (downloadBtn && downloadBtn.parentElement) {
        downloadBtn.insertAdjacentElement('afterend', oneClick);
      } else {
        document.body.insertBefore(oneClick, document.body.firstChild);
      }

      oneClick.addEventListener('click', async (e) => {
        e.preventDefault();
        if (oneClick.classList.contains('wnacg-disabled')) return;
        oneClick.classList.add('wnacg-disabled');
        oneClick.setAttribute('aria-disabled', 'true');
        try {
          const queue = createDownloadQueue();
          queue.addTask(aid);
          appendPanelLog(`开始下载相册 aid=${aid}`);
          await queue.start();
        } finally {
          oneClick.classList.remove('wnacg-disabled');
          oneClick.removeAttribute('aria-disabled');
        }
      });

      const popularityPanel = ensureAlbumPopularityPanel(oneClick);
      bindAlbumPopularityRefresh(popularityPanel, aid);
      loadAndRenderAlbumPopularity(aid, popularityPanel, { forceRefresh: false });

      ensureAlbumSeriesButton(aid, oneClick, oneClick.className);

      // 系列作品：仅在可识别系列关键词时显示
      initAlbumSeriesPanel(aid);

      log('相册页初始化完成');
    } catch (error) {
      log(`相册页初始化出错: ${error.message}`, 'error');
      console.error(error);
    }
  }

  // ============ 下载管理框架 ============
  
  /**
   * 获取相册下载直链
   * @param {string|number} aid 相册 ID
   * @returns {Promise<{url: string, filename: string}|null>} 下载信息或 null
   */
  async function fetchDownloadUrl(aid) {
    const downloadPageUrl = `${location.origin}/download-index-aid-${aid}.html`;
    log(`正在获取下载链接: ${downloadPageUrl}`);

    try {
      const doc = await fetchHtmlDocument(downloadPageUrl);
      if (!doc) return null;

      const adsLink = doc.querySelector('a.ads');
      const rawHref = adsLink ? (adsLink.getAttribute('href') || '') : '';
      if (!rawHref) {
        log('未找到 Server 2 下载链接 (a.ads)', 'warn');
        return null;
      }

      let downloadUrl = rawHref;
      if (downloadUrl.startsWith('//')) {
        downloadUrl = 'https:' + downloadUrl;
      } else if (downloadUrl.startsWith('/')) {
        downloadUrl = new URL(downloadUrl, location.origin).toString();
      } else if (!/^https?:/i.test(downloadUrl)) {
        downloadUrl = new URL(downloadUrl, location.origin).toString();
      }

      let filename = `album_${aid}.zip`;
      try {
        const urlObj = new URL(downloadUrl);
        const nameParam = urlObj.searchParams.get('n');
        if (nameParam) {
          const decoded = decodeURIComponent(nameParam);
          filename = decoded.toLowerCase().endsWith('.zip') ? decoded : `${decoded}.zip`;
        }
      } catch (e) {
        log(`解析文件名失败，使用默认文件名: ${e.message}`, 'warn');
      }

      filename = sanitizeFilename(filename);
      log(`成功获取下载链接: ${filename}`);
      return { url: downloadUrl, filename };
    } catch (error) {
      log(`解析下载页出错: ${error.message}`, 'error');
      return null;
    }
  }

  /**
   * 触发文件下载
   * @param {string} url 下载 URL
   * @param {string} filename 文件名
   * @returns {Promise<boolean>} 是否成功触发下载
   */
  async function triggerDownload(url, filename) {
    return new Promise((resolve) => {
      const safeName = sanitizeFilename(filename);
      log(`开始下载: ${safeName}`);
      
      // 优先使用 GM_download
      if (typeof GM_download === 'function') {
        try {
          GM_download({
            url: url,
            name: safeName,
            saveAs: false,
            onload: function() {
              log(`下载完成: ${safeName}`);
              resolve(true);
            },
            onerror: function(error) {
              log(`下载失败: ${safeName}, 错误: ${error.error}`, 'error');
              resolve(false);
            },
            ontimeout: function() {
              log(`下载超时: ${safeName}`, 'error');
              resolve(false);
            }
          });
        } catch (error) {
          log(`GM_download 调用失败: ${error.message}`, 'error');
          resolve(false);
        }
      } else {
        // 降级方案：使用 <a> 标签
        log('GM_download 不可用，使用 <a> 标签下载（浏览器可能会逐个弹确认）', 'warn');
        try {
          const link = document.createElement('a');
          link.href = url;
          link.download = safeName;
          link.style.display = 'none';
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          
          log(`已触发下载: ${safeName}`);
          resolve(true);
        } catch (error) {
          log(`<a> 标签下载失败: ${error.message}`, 'error');
          resolve(false);
        }
      }
    });
  }
  
  /**
   * 下载队列管理类
   * 提供串行下载任务队列管理功能
   */
  class DownloadQueue {
    /**
     * 构造函数
     * @param {Object} options 配置选项
     * @param {number} options.delayBetweenTasks 任务间隔时间（毫秒），默认 3000
     * @param {number} options.maxRetries 失败重试次数，默认 2
     */
    constructor(options = {}) {
      this.delayBetweenTasks = options.delayBetweenTasks || 3000;
      this.maxRetries = options.maxRetries || 2;
      
      // 任务队列
      this.tasks = [];
      
      // 状态标志
      this.isRunning = false;
      this.isPaused = false;
      this.isCancelled = false;
      
      // 当前处理索引
      this.currentIndex = 0;
      this.isTaskInProgress = false;
      
      // 统计信息
      this.stats = {
        total: 0,
        successful: 0,
        failed: 0
      };
      
      // 事件监听器
      this.listeners = {
        progress: [],
        completed: [],
        error: []
      };
    }
    
    /**
     * 注册事件监听器
     * @param {string} eventName 事件名称（'progress', 'completed', 'error'）
     * @param {Function} callback 回调函数
     */
    on(eventName, callback) {
      if (this.listeners[eventName]) {
        this.listeners[eventName].push(callback);
      }
    }
    
    /**
     * 触发事件
     * @param {string} eventName 事件名称
     * @param {*} data 事件数据
     */
    _emit(eventName, data) {
      if (this.listeners[eventName]) {
        this.listeners[eventName].forEach(callback => {
          try {
            callback(data);
          } catch (error) {
            log(`事件回调执行出错 (${eventName}): ${error.message}`, 'error');
          }
        });
      }
    }
    
    /**
     * 添加任务到队列
     * @param {string|number} aid 相册 ID
     */
    addTask(aid) {
      this.tasks.push({
        aid: aid,
        retryCount: 0,
        status: 'pending'
      });
      this.stats.total++;
    }
    
    /**
     * 开始处理队列
     */
    async start() {
      if (this.isRunning) {
        log('队列已在运行中', 'warn');
        return;
      }
      
      if (this.tasks.length === 0) {
        log('队列为空，无任务可执行', 'warn');
        return;
      }
      
      this.isRunning = true;
      this.isCancelled = false;
      this.isPaused = false;
      this.currentIndex = 0;
      
      log(`开始处理下载队列，共 ${this.tasks.length} 个任务`);
      
      await this._processQueue();
    }
    
    /**
     * 暂停处理
     */
    pause() {
      if (!this.isRunning) {
        log('队列未运行，无法暂停', 'warn');
        return;
      }
      
      this.isPaused = true;
      log('队列已暂停');
    }
    
    /**
     * 恢复处理
     */
    async resume() {
      if (!this.isRunning) {
        log('队列未运行，无法恢复', 'warn');
        return;
      }
      
      if (!this.isPaused) {
        log('队列未暂停，无需恢复', 'warn');
        return;
      }
      
      this.isPaused = false;
      log('队列已恢复');
      
      // 继续处理队列
      await this._processQueue();
    }
    
    /**
     * 取消所有任务
     */
    cancel() {
      this.isCancelled = true;
      this.isPaused = false;
      this.isRunning = false;
      log('队列已取消');
    }

    clear() {
      const preserveCount = this.isTaskInProgress
        ? Math.min(this.currentIndex + 1, this.tasks.length)
        : Math.min(this.currentIndex, this.tasks.length);
      const removed = Math.max(this.tasks.length - preserveCount, 0);

      if (removed > 0) {
        this.tasks.splice(preserveCount);
      }

      this.stats.total = this.tasks.length;
      this.isCancelled = true;
      this.isPaused = false;
      if (!this.isTaskInProgress && this.tasks.length === 0) {
        this.isRunning = false;
        this.currentIndex = 0;
        this.stats.successful = 0;
        this.stats.failed = 0;
      }

      return removed;
    }
    
    /**
     * 处理队列（内部方法）
     */
    async _processQueue() {
      while (this.currentIndex < this.tasks.length) {
        // 检查是否被取消
        if (this.isCancelled) {
          log('队列处理已取消');
          break;
        }
        
        // 检查是否被暂停
        if (this.isPaused) {
          log('队列处理已暂停');
          return;
        }
        
        const task = this.tasks[this.currentIndex];
        
        // 处理当前任务
        const success = await this._processTask(task);
        if (this.isCancelled) {
          log('队列已清空，停止后续任务');
          break;
        }
        
        if (success) {
          task.status = 'completed';
          this.stats.successful++;
        } else {
          // 检查是否需要重试
          if (task.retryCount < this.maxRetries) {
            task.retryCount++;
            task.status = 'retry';
            log(`任务 ${task.aid} 失败，准备重试 (${task.retryCount}/${this.maxRetries})`);
            
            // 触发错误事件
            this._emit('error', {
              aid: task.aid,
              message: '下载失败，正在重试',
              retryCount: task.retryCount
            });
            
            // 等待后重试（不移动索引）
            await this._delay(this.delayBetweenTasks);
            continue;
          } else {
            task.status = 'failed';
            this.stats.failed++;
            
            // 触发错误事件
            this._emit('error', {
              aid: task.aid,
              message: '下载失败，已达最大重试次数',
              retryCount: task.retryCount
            });
          }
        }
        
        // 触发进度事件
        this._emit('progress', {
          current: this.currentIndex + 1,
          total: this.tasks.length,
          filename: task.filename || `album_${task.aid}.zip`
        });
        
        // 移动到下一个任务
        this.currentIndex++;
        
        // 如果还有任务，等待指定时间
        if (this.currentIndex < this.tasks.length) {
          await this._delay(this.delayBetweenTasks);
        }
      }
      
      // 所有任务处理完成
      this.isRunning = false;
      
      log(`队列处理完成：总计 ${this.stats.total}，成功 ${this.stats.successful}，失败 ${this.stats.failed}`);
      
      // 触发完成事件
      this._emit('completed', {
        total: this.stats.total,
        successful: this.stats.successful,
        failed: this.stats.failed
      });
    }
    
    /**
     * 处理单个任务（内部方法）
     * @param {Object} task 任务对象
     * @returns {Promise<boolean>} 是否成功
     */
    async _processTask(task) {
      this.isTaskInProgress = true;
      try {
        task.status = 'downloading';
        log(`开始处理任务: ${task.aid}`);
        
        // 获取下载链接
        const downloadInfo = await fetchDownloadUrl(task.aid);
        
        if (!downloadInfo) {
          log(`获取下载链接失败: ${task.aid}`, 'error');
          return false;
        }
        
        // 保存文件名供进度事件使用
        task.filename = downloadInfo.filename;
        
        // 触发下载
        const success = await triggerDownload(downloadInfo.url, downloadInfo.filename);
        
        if (!success) {
          log(`触发下载失败: ${task.aid}`, 'error');
          return false;
        }
        
        log(`任务完成: ${task.aid}`);
        return true;
        
      } catch (error) {
        log(`处理任务出错 (${task.aid}): ${error.message}`, 'error');
        return false;
      } finally {
        this.isTaskInProgress = false;
      }
    }
    
    /**
     * 延迟指定时间（内部方法）
     * @param {number} ms 毫秒数
     * @returns {Promise<void>}
     */
    _delay(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }
  }

  // ============ 主执行流程 ============

  /**
   * 初始化脚本
   */
  function initialize() {
    try {
      log(`脚本加载成功，当前 URL: ${location.href}`);
      
      // 注入基础样式
      injectBaseStyles();
      
      // 检测当前页面类型
      STATE.currentPageType = detectPageType();
      
      if (!STATE.currentPageType) {
        log(`当前页面不是目标页面，脚本退出`, 'warn');
        return;
      }
      
      log(`检测到页面类型: ${STATE.currentPageType}`);
      
      // 根据页面类型执行对应的初始化
      if (STATE.currentPageType === CONFIG.PAGE_TYPE.SHELF) {
        // 确保 DOM 已加载
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', initShelfPage);
        } else {
          initShelfPage();
        }
      } else if (STATE.currentPageType === CONFIG.PAGE_TYPE.ALBUM) {
        // 确保 DOM 已加载
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', initAlbumPage);
        } else {
          initAlbumPage();
        }
      } else if (STATE.currentPageType === CONFIG.PAGE_TYPE.GALLERY) {
        // 确保 DOM 已加载
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', initGalleryPage);
        } else {
          initGalleryPage();
        }
      }
      
      STATE.isInitialized = true;
      log('脚本初始化完成');
      
    } catch (error) {
      log(`初始化出错: ${error.message}`, 'error');
      console.error(error);
    }
  }

  // 脚本入口
  initialize();

})();
