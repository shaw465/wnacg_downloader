// ==UserScript==
// @name         WNACG 批量下载器
// @namespace    http://tampermonkey.net/
// @version      0.4.1
// @description  为 WNACG 多镜像站点提供书架、相册和画廊页批量下载功能（兼容移动阅读页）
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
// @run-at       document-end
// ==/UserScript==

(function() {
  'use strict';

  // ============ 全局配置 ============
  const CONFIG = {
    // 脚本版本
    VERSION: '0.4.1',
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
    ui: {
      progressPanel: null,
      progressFill: null,
      progressText: null,
      logBox: null,
      pauseBtn: null,
      clearQueueBtn: null,
      minimized: false
    }
  };

  // ============ 选择持久化（sessionStorage） ============
  const STORAGE_KEY = 'wnacg_bd_selected_aids';
  const MODE_STORAGE_KEY = 'wnacg_bd_select_mode';

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

        applySelectMode(getStoredSelectMode());
        updateGallerySelectedCount();
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

      log(`画廊页初始化完成，共注入 ${injectedCount} 个 checkbox`);
    } catch (error) {
      log(`画廊页初始化出错: ${error.message}`, 'error');
      console.error(error);
    }
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
