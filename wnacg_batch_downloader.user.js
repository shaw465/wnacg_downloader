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
      progressTitle: null,
      progressBar: null,
      progressFill: null,
      progressText: null,
      logBox: null,
      pauseBtn: null,
      clearQueueBtn: null,
      minimizeBtn: null,
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
  const IS_MOBILE = IS_NARROW || IS_TOUCH;

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
      :root {
        --wnacg-accent: #0f766e;
        --wnacg-accent-strong: #0c5e57;
        --wnacg-accent-soft: #e7f7f2;
        --wnacg-danger: #dc2626;
        --wnacg-danger-soft: #fee2e2;
        --wnacg-border: #d9e3ea;
        --wnacg-surface: #ffffff;
        --wnacg-surface-soft: #f8fbfd;
        --wnacg-text-main: #102a43;
        --wnacg-text-sub: #4e667e;
        --wnacg-shadow-sm: 0 2px 8px rgba(15, 23, 42, 0.08);
        --wnacg-shadow-md: 0 8px 22px rgba(15, 23, 42, 0.12);
        --wnacg-focus: #0ea5e9;
      }

      .wnacg-batch-btn {
        --btn-bg: linear-gradient(180deg, #16a085 0%, var(--wnacg-accent) 100%);
        --btn-border: var(--wnacg-accent);
        --btn-fg: #ffffff;
        min-height: 40px;
        padding: 0 14px;
        margin: 0;
        border: 1px solid var(--btn-border);
        border-radius: 10px;
        background: var(--btn-bg);
        color: var(--btn-fg) !important;
        font-size: 13px;
        font-weight: 600;
        line-height: 1;
        letter-spacing: 0;
        text-decoration: none;
        white-space: nowrap;
        cursor: pointer;
        user-select: none;
        box-shadow: 0 1px 2px rgba(15, 118, 110, 0.16);
        transition: transform 0.18s ease, box-shadow 0.18s ease, background-color 0.18s ease, border-color 0.18s ease;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        box-sizing: border-box;
      }
      
      .wnacg-batch-btn:hover {
        box-shadow: 0 6px 14px rgba(15, 118, 110, 0.24);
        transform: translateY(-1px);
      }

      .wnacg-batch-btn:active {
        transform: translateY(0);
        box-shadow: 0 2px 8px rgba(15, 118, 110, 0.2);
      }

      .wnacg-batch-btn:focus-visible {
        outline: 2px solid var(--wnacg-focus);
        outline-offset: 2px;
      }
      
      .wnacg-batch-btn:disabled {
        background: #cfd8dc;
        border-color: #b0bec5;
        cursor: not-allowed;
        transform: none;
        box-shadow: none;
      }

      .wnacg-btn-secondary {
        --btn-bg: #fff;
        --btn-border: #c8d8e4;
        --btn-fg: #335a78;
        box-shadow: none;
      }

      .wnacg-btn-secondary:hover {
        --btn-bg: #f6fbff;
        --btn-border: #a9c2d4;
      }

      .wnacg-btn-ghost {
        --btn-bg: #f2f6fa;
        --btn-border: #d4e0ea;
        --btn-fg: #365468;
        box-shadow: none;
      }

      .wnacg-btn-ghost:hover {
        --btn-bg: #e9f1f7;
      }

      .wnacg-btn-danger {
        --btn-bg: var(--wnacg-danger);
        --btn-border: var(--wnacg-danger);
        --btn-fg: #fff;
        box-shadow: 0 1px 2px rgba(220, 38, 38, 0.24);
      }

      .wnacg-btn-danger:hover {
        --btn-bg: #b91c1c;
        --btn-border: #b91c1c;
        box-shadow: 0 6px 14px rgba(220, 38, 38, 0.26);
      }

      .wnacg-album-action-row,
      .wnacg-shelf-toolbar,
      .wnacg-gallery-toolbar,
      .wnacg-series-panel {
        background: var(--wnacg-surface);
        border: 1px solid var(--wnacg-border);
        border-radius: 12px;
        box-shadow: var(--wnacg-shadow-sm);
      }

      .wnacg-album-action-row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 10px;
        margin: 10px 0 8px;
        padding: 10px;
      }

      .wnacg-album-action-row > a {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 40px;
        padding: 0 14px;
        border-radius: 10px;
        text-decoration: none;
        box-sizing: border-box;
        font-size: 13px;
        font-weight: 600;
      }

      .wnacg-album-oneclick-btn {
        border: 1px solid #1d4ed8 !important;
        background: linear-gradient(180deg, #3778ff 0%, #1d4ed8 100%) !important;
        color: #fff !important;
        box-shadow: 0 4px 12px rgba(29, 78, 216, 0.24);
      }

      .wnacg-album-oneclick-btn.wnacg-disabled {
        opacity: 0.6;
        pointer-events: none;
      }

      .wnacg-album-oneclick-btn:hover {
        background: linear-gradient(180deg, #2f72f7 0%, #1e40af 100%) !important;
      }

      .wnacg-album-series-btn {
        border: 1px solid #a8d7cc !important;
        background: var(--wnacg-accent-soft) !important;
        color: var(--wnacg-accent-strong) !important;
      }

      .wnacg-album-series-btn:hover {
        background: #d8f1e8 !important;
      }

      .wnacg-series-panel {
        margin: 12px 0 10px;
        padding: 14px;
        background: linear-gradient(180deg, #fbfefe 0%, #f4faf9 100%);
      }

      .wnacg-series-title {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 16px;
        font-weight: 600;
        color: var(--wnacg-text-main);
        margin-bottom: 6px;
      }

      .wnacg-series-keyword {
        color: #065f46;
        margin-left: 2px;
        font-weight: 600;
        font-size: 12px;
        padding: 3px 9px;
        border-radius: 999px;
        background: #d7f1e9;
        border: 1px solid #b7e4d6;
      }

      .wnacg-series-meta {
        margin-bottom: 10px;
        font-size: 12px;
        line-height: 1.55;
        color: var(--wnacg-text-sub);
      }

      .wnacg-series-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
        gap: 10px;
      }

      .wnacg-series-item {
        border: 1px solid #deebf3;
        border-radius: 10px;
        background: #fff;
        padding: 10px 12px;
        transition: border-color 0.18s ease, box-shadow 0.18s ease;
        min-height: 72px;
      }

      .wnacg-series-item:hover {
        border-color: #c2dff0;
        box-shadow: 0 4px 12px rgba(17, 112, 189, 0.14);
      }

      .wnacg-series-loading {
        font-size: 13px;
        color: var(--wnacg-text-sub);
        line-height: 1.5;
      }

      .wnacg-series-list a {
        color: #0f4c81;
        display: block;
        font-size: 14px;
        font-weight: 600;
        text-decoration: none;
        line-height: 1.45;
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

      .wnacg-series-submeta {
        margin-top: 4px;
        color: #627d98;
        font-size: 12px;
        line-height: 1.45;
      }
      .wnacg-progress-panel {
        position: fixed;
        bottom: 20px;
        right: 20px;
        width: 360px;
        max-width: calc(100vw - 20px);
        background: linear-gradient(180deg, #fdfefe 0%, #f7fafc 100%);
        border: 1px solid #d9e3ea;
        border-radius: 14px;
        padding: 14px;
        box-shadow: var(--wnacg-shadow-md);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
        z-index: 9999;
      }

      .wnacg-progress-panel.wnacg-minimized {
        width: auto;
        min-width: 180px;
        max-width: min(70vw, 320px);
        padding: 10px 12px;
      }

      .wnacg-progress-panel.wnacg-minimized .wnacg-progress-title {
        margin-bottom: 0;
        font-size: 13px;
      }
      
      .wnacg-progress-title {
        font-size: 15px;
        font-weight: 700;
        margin-bottom: 10px;
        color: #0f2438;
      }
      
      .wnacg-progress-bar {
        width: 100%;
        height: 9px;
        background-color: #dbe8f0;
        border-radius: 999px;
        overflow: hidden;
        margin-bottom: 10px;
      }
      
      .wnacg-progress-fill {
        height: 100%;
        background: linear-gradient(90deg, #10b981 0%, #0f766e 100%);
        transition: width 0.3s ease;
      }
      
       .wnacg-progress-text {
         font-size: 12px;
         color: #3b5368;
         margin-bottom: 12px;
         line-height: 1.45;
       }

       .wnacg-shelf-toolbar {
         display: flex;
         flex-wrap: wrap;
         align-items: center;
         gap: 10px;
         padding: 10px;
         margin: 10px 0;
         background: var(--wnacg-surface-soft);
       }

       .wnacg-shelf-toolbar label {
         display: inline-flex;
         align-items: center;
         gap: 6px;
         font-size: 12px;
         color: #34495e;
         user-select: none;
         min-height: 32px;
         padding: 0 8px;
         border-radius: 8px;
         background: #f3f8fb;
         border: 1px solid #d7e5ef;
       }

       .wnacg-shelf-checkbox {
         width: 18px;
         height: 18px;
         accent-color: var(--wnacg-accent);
         cursor: pointer;
       }

       #wnacg-include-all-pages {
         width: 16px;
         height: 16px;
         accent-color: #d97706;
         cursor: pointer;
       }

       .wnacg-shelf-count,
       .wnacg-gallery-count {
         margin-left: auto;
         font-size: 12px;
         color: #3f5b72;
         background: #eef5fa;
         border: 1px solid #d6e5ef;
         border-radius: 999px;
         padding: 6px 10px;
         font-weight: 600;
       }

       .wnacg-progress-log {
         max-height: 180px;
         overflow: auto;
         padding: 8px 10px;
         border: 1px solid #d6e3ed;
         border-radius: 8px;
         background: #fff;
         font-size: 12px;
         line-height: 1.4;
         color: #334155;
       }

       .wnacg-progress-log > div + div {
         margin-top: 4px;
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
          gap: 10px;
          padding: 10px;
          margin: 10px auto;
          max-width: 1200px;
          background: var(--wnacg-surface-soft);
          box-shadow: var(--wnacg-shadow-sm);
          z-index: 100;
          position: sticky;
          top: 10px;
        }

        .wnacg-gallery-toolbar .wnacg-batch-btn {
          padding: 0 12px;
          font-size: 12.5px;
          min-height: 36px;
        }

        .wnacg-gallery-mode-indicator {
          padding: 6px 10px;
          border-radius: 999px;
          border: 1px solid #d6d6d6;
          background: #f6f6f6;
          color: #5f6f80;
          font-size: 12px;
          white-space: nowrap;
        }

        .wnacg-gallery-mode-indicator.wnacg-active {
          border-color: #9ed3c5;
          background: #e7f7f2;
          color: #0f766e;
          font-weight: 600;
        }

        .wnacg-batch-btn.wnacg-select-mode-active {
          --btn-bg: #0f766e;
          --btn-border: #0f766e;
          --btn-fg: #fff;
        }

        .wnacg-batch-btn.wnacg-exit-mode-btn {
          --btn-bg: #dc2626;
          --btn-border: #dc2626;
          --btn-fg: #fff;
        }

        .wnacg-batch-btn.wnacg-exit-mode-btn:hover {
          --btn-bg: #b91c1c;
          --btn-border: #b91c1c;
        }

        .wnacg-gallery-hot-legend {
          flex: 1 1 100%;
          font-size: 12px;
          line-height: 1.4;
          color: #5f7380;
        }

        .wnacg-gallery-checkbox {
          position: absolute;
          top: 8px;
          left: 8px;
          width: 22px;
          height: 22px;
          cursor: pointer;
          z-index: 10;
          accent-color: #10b981;
          border-radius: 6px;
          border: 1px solid #bed2df;
          background: #fff;
          box-shadow: 0 1px 2px rgba(15, 23, 42, 0.18);
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
           border-radius: 12px;
           overflow: hidden;
           transition: box-shadow 0.18s ease, transform 0.18s ease;
         }

         li.gallary_item:hover,
         .wnacg-gallery-item:hover {
           box-shadow: 0 8px 20px rgba(15, 23, 42, 0.14);
           transform: translateY(-2px);
         }

         /* 选择模式下的卡片选中标记 */
         li.gallary_item.wnacg-selected::after,
         .wnacg-gallery-item.wnacg-selected::after {
           content: '';
           position: absolute;
           top: 0; left: 0; right: 0; bottom: 0;
           border: 2px solid #10b981;
           box-sizing: border-box;
           background: rgba(16, 185, 129, 0.18);
           pointer-events: none;
           z-index: 4;
         }

         li.gallary_item.wnacg-selected .pic_box::after,
         .wnacg-gallery-item.wnacg-selected .pic_box::after {
           content: '✓';
           position: absolute;
           top: 10px;
           right: 10px;
           width: 28px;
           height: 28px;
           border-radius: 50%;
           display: flex;
           align-items: center;
           justify-content: center;
           background: #10b981;
           color: #fff;
           font-size: 18px;
           font-weight: 700;
           box-shadow: 0 4px 10px rgba(16, 185, 129, 0.3);
           pointer-events: none;
           z-index: 5;
         }

         li.gallary_item .pic_box,
         .wnacg-gallery-item .pic_box {
           position: relative;
           z-index: 6;
         }

           /* 选择模式下封面的 cursor */
           body.wnacg-select-mode li.gallary_item .pic_box,
           body.wnacg-select-mode .wnacg-gallery-item .pic_box {
             cursor: pointer;
           }

          #wnacg-gallery-toolbar button + button {
            margin-left: 0;
          }

          /* ============ 移动端适配 ============ */
          @media (max-width: 768px) {
            :root {
              --wnacg-toolbar-h: 160px;
              --wnacg-sa-bottom: env(safe-area-inset-bottom, 0px);
            }

            /* 按钮触控友好 */
            .wnacg-batch-btn {
              min-height: 44px;
              padding: 0 14px;
              font-size: 13px;
              white-space: nowrap;
            }

            .wnacg-album-action-row {
              gap: 6px;
              padding: 8px;
            }

            .wnacg-album-action-row > a {
              min-height: 44px;
              flex: 1 1 calc(50% - 6px);
              min-width: 120px;
              padding: 0 10px;
              font-size: 14px;
            }

            .wnacg-series-panel {
              margin: 10px 0 8px;
              padding: 10px;
              border-radius: 10px;
            }

            .wnacg-series-item {
              padding: 10px;
            }

            .wnacg-series-list a {
              font-size: 14px;
              line-height: 1.45;
            }

            .wnacg-series-list {
              grid-template-columns: 1fr;
            }

            /* checkbox 增大命中区 */
            .wnacg-gallery-checkbox {
              width: 26px;
              height: 26px;
              top: 8px;
              left: 8px;
            }

            /* 画廊工具栏底部悬浮 */
            .wnacg-gallery-toolbar {
              position: fixed;
              left: 8px;
              right: 8px;
              top: auto;
              bottom: calc(env(safe-area-inset-bottom, 0px) + 4px);
              margin: 0;
              max-width: none;
              border-radius: 14px;
              padding: 10px;
              flex-wrap: wrap;
              justify-content: flex-start;
              gap: 8px;
              box-shadow: 0 -6px 20px rgba(0, 0, 0, 0.2);
              z-index: 9998;
              max-height: min(52vh, 260px);
              overflow-y: auto;
              -webkit-overflow-scrolling: touch;
            }

            .wnacg-gallery-toolbar .wnacg-batch-btn {
              flex: 1 1 calc(33.33% - 6px);
              min-width: 84px;
              font-size: 12px;
            }

            .wnacg-gallery-mode-indicator {
              width: 100%;
              order: 9;
              white-space: normal;
              line-height: 1.35;
            }

            .wnacg-gallery-count {
              width: 100%;
              order: 10;
              margin-left: 0;
              text-align: center;
            }

            /* 工具栏存在时页面底部留白 */
            body.wnacg-mobile-has-toolbar {
              padding-bottom: calc(var(--wnacg-toolbar-h) + env(safe-area-inset-bottom, 0px)) !important;
            }

            /* 进度面板底部全宽 */
            .wnacg-progress-panel {
              left: auto;
              right: 8px;
              top: auto;
              width: min(92vw, 360px);
              border-radius: 14px;
              max-height: 52vh;
              overflow-y: auto;
            }
            /* 工具栏存在时进度面板偏移 */
            body.wnacg-mobile-has-toolbar .wnacg-progress-panel {
              bottom: calc(var(--wnacg-toolbar-h) + env(safe-area-inset-bottom, 0px) + 16px);
            }

            .wnacg-progress-panel.wnacg-minimized {
              left: auto;
              right: 8px;
              width: auto;
              min-width: 0;
              max-width: 72vw;
              border-radius: 999px;
              padding: 8px 10px;
            }

            .wnacg-progress-panel.wnacg-minimized .wnacg-progress-title {
              font-size: 12px;
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

      @media (prefers-reduced-motion: reduce) {
        .wnacg-batch-btn,
        .wnacg-album-oneclick-btn,
        .wnacg-album-series-btn,
        li.gallary_item,
        .wnacg-gallery-item {
          transition: none !important;
          transform: none !important;
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
      .replace(/<[^>]*>/g, ' ')
      .replace(/&(?:lt|gt|amp|quot|#39);/gi, ' ')
      .replace(/\[[^\]]*\]/g, ' ')
      .replace(/[【】「」『』（）()《》〈〉［］\[\]\s_\-–—:：,，.。!?！？~～|｜\\/]+/g, '')
      .trim();
  }

  const SERIES_MASK_CHAR_CLASS = '[●○◎◆◇□■＊*･・]';

  /**
   * 判断标题是否匹配系列关键词（支持站点常见打码字符）
   * @param {string} title
   * @param {string} keyword
   * @returns {boolean}
   */
  function matchesSeriesKeyword(title, keyword) {
    const normalizedTitle = normalizeSeriesText(title);
    const normalizedKeyword = normalizeSeriesText(keyword);
    if (!normalizedTitle || !normalizedKeyword) return false;
    if (normalizedTitle.includes(normalizedKeyword)) return true;

    const escaped = String(normalizedKeyword)
      .split('')
      .map((ch) => {
        if (/[●○◎◆◇□■＊*･・]/.test(ch)) return SERIES_MASK_CHAR_CLASS;
        const safe = ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return `(?:${safe}|${SERIES_MASK_CHAR_CLASS})`;
      })
      .join('');

    try {
      return new RegExp(escaped, 'i').test(normalizedTitle);
    } catch {
      return false;
    }
  }

  const SERIES_MARKER_RE = /(第?\s*\d+(?:\s*[-~～]\s*\d+)?\s*[话話回卷章部]|(?:vol|VOL)\.?\s*\d+(?:\.\d+)?|#\s*\d+|(?:part|Part)\s*\d+|[上中下前后後]\s*篇?)/;
  const SERIES_STOPWORD_SET = new Set([
    'tag',
    'tags',
    '漢化',
    '汉化',
    '同人誌',
    '同人志',
    '分類',
    '分类',
    '頁數',
    '页数'
  ]);

  /**
   * 清理系列关键词文本
   * @param {string} input
   * @returns {string}
   */
  function cleanupSeriesKeyword(input) {
    return String(input || '')
      .replace(/^\s*(?:\[[^\]]+\]\s*)+/g, '')
      .replace(/\s*(?:\[[^\]]+\]\s*)+$/g, '')
      .replace(/^[\s\-–—:：,，.。!?！？~～|｜\\/]+/g, '')
      .replace(/[\s\-–—:：,，.。!?！？~～|｜\\/]+$/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  /**
   * 去掉标题末尾的“第X话/Vol.X/Part X”等编号
   * @param {string} input
   * @returns {string}
   */
  function stripTrailingSeriesMarker(input) {
    return String(input || '')
      .replace(/\s*(?:第?\s*\d+(?:\s*[-~～]\s*\d+)?\s*[话話回卷章部]|(?:vol|VOL)\.?\s*\d+(?:\.\d+)?|#\s*\d+|(?:part|Part)\s*\d+|[上中下前后後]\s*篇?)+\s*$/gi, '')
      .replace(/[\s\-–—:：,，.。!?！？~～]+$/g, '')
      .trim();
  }

  /**
   * 抽取相册页标签中的候选关键词
   * @returns {string[]}
   */
  function extractAlbumTagKeywords() {
    const candidates = [];
    const push = (value) => {
      const text = String(value || '').trim();
      if (text) candidates.push(text);
    };

    const tagLinks = document.querySelectorAll('a[href*="albums-index-tag-"], .tagshow a');
    for (const link of tagLinks) {
      push(link.textContent || '');
    }

    if (candidates.length < 2) {
      const nodes = document.querySelectorAll('.tagshow, .uwconn span, .uwconn p, .asTB span, .asTB p, .pic_box_tb span, .pic_box_tb p');
      for (const el of nodes) {
        const full = String(el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!/(?:標籤|标签)\s*[：:]/i.test(full)) continue;
        let tagText = full.replace(/^.*?(?:標籤|标签)\s*[：:]\s*/i, '');
        tagText = tagText.split(/(?:分類|分类|頁數|页数|作者|上傳|上传|日期|簡介|简介)\s*[：:]/i)[0].trim();
        if (!tagText) continue;
        push(tagText);
      }
    }

    const expanded = [];
    for (const item of candidates) {
      expanded.push(item);
      const parts = item
        .replace(/[!！；;]+/g, ' ')
        .split(/[+＋|｜,，、/\\\s]+/)
        .map((part) => part.trim())
        .filter(Boolean);
      for (const part of parts) expanded.push(part);
    }

    const uniq = new Map();
    for (const value of expanded) {
      const cleaned = cleanupSeriesKeyword(value);
      if (!cleaned) continue;
      const normalized = normalizeSeriesText(cleaned);
      if (!normalized) continue;
      if (/^[+#+]*tag[s]?$/i.test(normalized)) continue;
      if (SERIES_STOPWORD_SET.has(normalized)) continue;
      if (!uniq.has(normalized)) uniq.set(normalized, cleaned);
    }
    return Array.from(uniq.values());
  }

  const AUTHOR_TAG_STOPWORD_SET = new Set([
    '巨乳', '貧乳', '萝莉', '蘿莉', '人妻', '熟女', '触手', '獸人', '兽人',
    'ntr', '純愛', '纯爱', '同人誌', '同人志', '單行本', '单行本', '雜誌', '杂志',
    '韓漫', '韩漫', '漢化', '汉化', '中國翻譯', '中国翻译', '日語', '日语',
    'fullcolor', 'full', 'color', '无码', '無修正', '无修正', 'dl版', 'dl',
    'tag', 'tags', '更新', '排行'
  ].map((item) => normalizeSeriesText(item)));

  /**
   * 提取相册页标签（含链接）
   * @returns {Array<{name:string,url:string}>}
   */
  function extractAlbumTagEntries() {
    const map = new Map();
    const links = Array.from(document.querySelectorAll('a[href*="albums-index-tag-"], .tagshow a[href]'));
    for (const link of links) {
      const name = cleanupSeriesKeyword(link.textContent || '');
      if (!name) continue;
      const normalized = normalizeSeriesText(name);
      if (!normalized) continue;
      const href = link.getAttribute('href') || link.href || '';
      if (!href) continue;
      try {
        const url = new URL(href, location.origin).toString();
        if (!map.has(normalized)) map.set(normalized, { name, url });
      } catch {}
    }
    return Array.from(map.values());
  }

  /**
   * 从标题中提取作者/社团候选词
   * @param {string} title
   * @returns {string[]}
   */
  function extractTitleCreatorCandidates(title) {
    const text = cleanupSeriesKeyword(String(title || '').split(/[|｜]/)[0]);
    if (!text) return [];

    const candidates = [];
    const push = (raw) => {
      const cleaned = cleanupSeriesKeyword(raw)
        .replace(/^(?:社團|社团|circle)\s*/i, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
      if (!cleaned) return;
      if (/^(?:c\d{2,4}|comic\d*|dl版|dl|無修正|无修正|中國翻譯|中国翻译|漢化|汉化)$/i.test(cleaned)) return;
      if (/^[\d.\-~～]+$/.test(cleaned)) return;
      candidates.push(cleaned);
    };

    const leading = text.match(/^\s*(?:(?:\[[^\]]+\]|【[^】]+】|\([^)]*\)|（[^）]*）)\s*){1,5}/);
    const blocks = leading ? (leading[0].match(/\[[^\]]+\]|【[^】]+】|\([^)]*\)|（[^）]*）/g) || []) : [];
    for (const block of blocks) {
      const inner = block.replace(/^[\[\(（【]\s*|\s*[\]\)）】]$/g, '').trim();
      if (!inner) continue;
      push(inner);

      const pair = inner.match(/^(.+?)\s*[\(（]([^)）]{1,40})[\)）]\s*$/);
      if (pair) {
        push(pair[1]);
        push(pair[2]);
      }

      const parts = inner
        .split(/[\/／&＆,，+＋|｜]/)
        .map((part) => part.trim())
        .filter(Boolean);
      for (const part of parts) push(part);
    }

    const uniq = new Map();
    for (const item of candidates) {
      const normalized = normalizeSeriesText(item);
      if (!normalized) continue;
      if (normalized.length < 2 || normalized.length > 40) continue;
      if (!uniq.has(normalized)) uniq.set(normalized, item);
    }
    return Array.from(uniq.values());
  }

  /**
   * 评估某个标签是否更像“作者标签”
   * @param {string} tagName
   * @param {string} title
   * @param {string[]} creatorCandidates
   * @param {string[]} keywordCandidates
   * @returns {number}
   */
  function scoreAuthorTagCandidate(tagName, title, creatorCandidates, keywordCandidates) {
    const normalizedTag = normalizeSeriesText(tagName);
    if (!normalizedTag) return Number.NEGATIVE_INFINITY;

    let score = 0;
    if (AUTHOR_TAG_STOPWORD_SET.has(normalizedTag)) score -= 120;

    const titleScore = scoreKeywordAgainstTitle(tagName, title);
    score += Math.min(titleScore, 60);

    for (const creator of creatorCandidates) {
      if (matchesSeriesKeyword(tagName, creator) || matchesSeriesKeyword(creator, tagName)) {
        score += 120;
        break;
      }
    }

    for (const keyword of keywordCandidates) {
      const normalizedKeyword = normalizeSeriesText(keyword);
      if (!normalizedKeyword) continue;
      if (normalizedTag === normalizedKeyword) score -= 45;
      else if (normalizedTag.includes(normalizedKeyword) || normalizedKeyword.includes(normalizedTag)) score -= 25;
    }

    if (/[\u3040-\u30ff]/.test(tagName)) score += 10;
    if (/[a-zA-Z]/.test(tagName)) score += 6;
    if (/(?:先生|老師|老师|氏)$/.test(tagName)) score += 8;

    if (normalizedTag.length > 24) score -= 12;
    if (normalizedTag.length <= 2) score -= 8;

    return score;
  }

  /**
   * 选择最可能的作者标签候选
   * @param {string} title
   * @param {string[]} keywordCandidates
   * @param {number} maxCount
   * @returns {Array<{name:string,url:string,score:number}>}
   */
  function selectAuthorTagCandidates(title, keywordCandidates = [], maxCount = 2) {
    const tagEntries = extractAlbumTagEntries();
    if (tagEntries.length === 0) return [];

    const creatorCandidates = extractTitleCreatorCandidates(title);
    const scored = tagEntries
      .map((entry) => ({
        ...entry,
        score: scoreAuthorTagCandidate(entry.name, title, creatorCandidates, keywordCandidates)
      }))
      .filter((entry) => Number.isFinite(entry.score))
      .sort((a, b) => b.score - a.score || String(a.name).length - String(b.name).length);

    const selected = scored.filter((entry) => entry.score >= 25).slice(0, maxCount);
    if (selected.length > 0) return selected;

    // 兜底：至少返回一个非明显通用标签，避免完全走不到“同作者”路径
    return scored
      .filter((entry) => !AUTHOR_TAG_STOPWORD_SET.has(normalizeSeriesText(entry.name)))
      .slice(0, 1);
  }

  /**
   * 计算候选词与当前标题的相似度（用于标签优先级）
   * @param {string} keyword
   * @param {string} title
   * @returns {number}
   */
  function scoreKeywordAgainstTitle(keyword, title) {
    const stripMask = (input) => String(input || '').replace(/[●○◎◆◇□■＊*･・]/g, '');
    const kw = stripMask(normalizeSeriesText(keyword));
    const tt = stripMask(normalizeSeriesText(title));
    if (!kw || !tt) return 0;
    if (tt.includes(kw)) return 100 + kw.length;
    if (kw.includes(tt)) return 80 + tt.length;

    let overlap = 0;
    for (const ch of new Set(kw.split(''))) {
      if (tt.includes(ch)) overlap++;
    }
    return overlap * 10 + Math.min(kw.length, 12);
  }

  /**
   * 构建系列检索关键词候选列表（按优先级排序）
   * @param {string} title
   * @param {string} customKeyword
   * @returns {string[]}
   */
  function buildSeriesKeywordCandidates(title, customKeyword = '') {
    const map = new Map();
    const add = (raw) => {
      const cleaned = cleanupSeriesKeyword(raw);
      if (!cleaned) return;
      const stripped = stripTrailingSeriesMarker(cleaned);
      const finalText = stripped || cleaned;
      const normalized = normalizeSeriesText(finalText);
      if (!normalized) return;
      const isCjk = /[\u3400-\u9fff]/.test(normalized);
      const minLen = isCjk ? 2 : 3;
      if (normalized.length < minLen) return;
      if (SERIES_STOPWORD_SET.has(normalized)) return;
      if (!map.has(normalized)) map.set(normalized, finalText);
    };

    if (customKeyword) add(customKeyword);

    let mainTitle = cleanupSeriesKeyword(String(title || '').split(/[|｜]/)[0]);
    const hasMaskedChar = /[●○◎◆◇□■＊*･・]/.test(mainTitle);
    let prefixCandidate = '';
    let markerCandidate = '';
    if (mainTitle) {
      const prefixMatch = mainTitle.match(/^(.+?)\s*[-–—:：~～]\s*.+$/);
      if (prefixMatch) prefixCandidate = prefixMatch[1];

      if (SERIES_MARKER_RE.test(mainTitle)) markerCandidate = stripTrailingSeriesMarker(mainTitle);
    }

    const tagKeywords = extractAlbumTagKeywords()
      .sort((a, b) => {
        const scoreDiff = scoreKeywordAgainstTitle(b, mainTitle) - scoreKeywordAgainstTitle(a, mainTitle);
        if (scoreDiff !== 0) return scoreDiff;
        return String(b).length - String(a).length;
      });

    if (hasMaskedChar) {
      add(prefixCandidate);
      add(markerCandidate);
      for (const tag of tagKeywords) add(tag);
      add(mainTitle);
    } else {
      add(prefixCandidate);
      add(markerCandidate);
      add(mainTitle);
      for (const tag of tagKeywords) add(tag);
    }

    return Array.from(map.values()).slice(0, 6);
  }

  /**
   * 从相册标题推断系列关键词
   * @param {string} title
   * @returns {string}
   */
  function extractSeriesKeyword(title) {
    const candidates = buildSeriesKeywordCandidates(title);
    return candidates[0] || '';
  }

  /**
   * 手动搜索时的关键词建议（比自动识别更宽松）
   * @param {string} title
   * @returns {string}
   */
  function deriveSeriesKeywordSuggestion(title) {
    const candidates = buildSeriesKeywordCandidates(title);
    return candidates[0] || '';
  }

  /**
   * 归一化并剔除系列比较时的噪声字符
   * @param {string} input
   * @returns {string}
   */
  function stripSeriesNoiseForCompare(input) {
    return normalizeSeriesText(input)
      .replace(/(?:中國翻譯|中国翻译|中國|中国|漢化|汉化|無修正|无修正|dl版|digital|熟肉|機翻|机翻|補檔|补档|重傳|重传|轉載|转载|搬運|搬运)/gi, '')
      .replace(/\d+(?:\.\d+)?/g, '')
      .trim();
  }

  /**
   * 最长公共子串长度
   * @param {string} a
   * @param {string} b
   * @returns {number}
   */
  function longestCommonSubstringLength(a, b) {
    const s1 = String(a || '');
    const s2 = String(b || '');
    if (!s1 || !s2) return 0;
    const m = s1.length;
    const n = s2.length;
    const dp = new Array(n + 1).fill(0);
    let maxLen = 0;

    for (let i = 1; i <= m; i += 1) {
      for (let j = n; j >= 1; j -= 1) {
        if (s1[i - 1] === s2[j - 1]) {
          dp[j] = dp[j - 1] + 1;
          if (dp[j] > maxLen) maxLen = dp[j];
        } else {
          dp[j] = 0;
        }
      }
    }
    return maxLen;
  }

  /**
   * 构建标题 token 集合（中日韩二元组 + 英文词）
   * @param {string} input
   * @returns {Set<string>}
   */
  function buildSeriesTokenSet(input) {
    const text = stripSeriesNoiseForCompare(input);
    const set = new Set();
    if (!text) return set;

    const latinWords = text.match(/[a-z]{2,}/gi) || [];
    for (const word of latinWords) set.add(word.toLowerCase());

    const cjkRuns = text.match(/[\u3400-\u9fff]{2,}/g) || [];
    for (const run of cjkRuns) {
      set.add(run);
      if (run.length <= 2) continue;
      for (let i = 0; i < run.length - 1; i += 1) {
        set.add(run.slice(i, i + 2));
      }
    }

    return set;
  }

  /**
   * 计算标题“同系列亲和分”
   * @param {string} currentTitle
   * @param {string} candidateTitle
   * @param {string} keyword
   * @returns {number}
   */
  function computeSeriesAffinityScore(currentTitle, candidateTitle, keyword) {
    const currentNorm = stripSeriesNoiseForCompare(currentTitle);
    const candidateNorm = stripSeriesNoiseForCompare(candidateTitle);
    if (!currentNorm || !candidateNorm) return 0;

    let score = 0;
    if (matchesSeriesKeyword(candidateTitle, keyword)) score += 45;

    const lcs = longestCommonSubstringLength(currentNorm, candidateNorm);
    score += Math.min(lcs, 28) * 2;

    const tokensA = buildSeriesTokenSet(currentNorm);
    const tokensB = buildSeriesTokenSet(candidateNorm);
    if (tokensA.size > 0 && tokensB.size > 0) {
      let inter = 0;
      for (const token of tokensA) {
        if (tokensB.has(token)) inter += 1;
      }
      const union = new Set([...tokensA, ...tokensB]).size || 1;
      const jaccard = inter / union;
      score += Math.round(jaccard * 100);
    }

    const currentOrder = extractSeriesOrderValue(currentTitle);
    const candidateOrder = extractSeriesOrderValue(candidateTitle);
    if (Number.isFinite(currentOrder) && Number.isFinite(candidateOrder)) {
      const delta = Math.abs(candidateOrder - currentOrder);
      if (delta <= 2) score += 8;
      else if (delta <= 5) score += 4;
    }

    return score;
  }

  /**
   * 判断关键词是否疑似作者词（用于过滤误匹配）
   * @param {string} keyword
   * @param {string[]} creatorCandidates
   * @returns {boolean}
   */
  function isLikelyAuthorKeyword(keyword, creatorCandidates) {
    const normalizedKeyword = normalizeSeriesText(keyword);
    if (!normalizedKeyword) return false;
    for (const creator of creatorCandidates) {
      const normalizedCreator = normalizeSeriesText(creator);
      if (!normalizedCreator) continue;
      if (normalizedKeyword === normalizedCreator) return true;
      if (normalizedKeyword.length >= 2 && normalizedCreator.includes(normalizedKeyword) && normalizedKeyword.length <= 4) return true;
      if (normalizedCreator.length >= 2 && normalizedKeyword.includes(normalizedCreator) && normalizedCreator.length <= 4) return true;
    }
    return false;
  }

  /**
   * 构建可用于系列匹配的关键词（过滤作者名/过泛词）
   * @param {string[]} keywordCandidates
   * @param {string} currentTitle
   * @param {string} customKeyword
   * @returns {string[]}
   */
  function buildValidSeriesKeywords(keywordCandidates, currentTitle, customKeyword = '') {
    const creatorCandidates = extractTitleCreatorCandidates(currentTitle);
    const dedup = new Map();
    const isCustom = Boolean(String(customKeyword || '').trim());

    for (const candidate of keywordCandidates) {
      const text = String(candidate || '').trim();
      if (!text) continue;
      const normalized = normalizeSeriesText(text);
      if (!normalized) continue;
      const hasCjk = /[\u3400-\u9fff]/.test(normalized);
      const minLen = hasCjk ? 2 : 3;
      if (normalized.length < minLen) continue;
      if (!isCustom && isLikelyAuthorKeyword(text, creatorCandidates)) continue;
      if (!dedup.has(normalized)) dedup.set(normalized, text);
    }

    return Array.from(dedup.values());
  }

  /**
   * 清理列表页抓取到的标题文本
   * @param {string} raw
   * @returns {string}
   */
  function cleanupAlbumEntryTitle(raw) {
    return String(raw || '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&(?:lt|gt|amp|quot|#39);/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * 估算标题质量，分数越高越接近真实作品名
   * @param {string} title
   * @returns {number}
   */
  function getAlbumEntryTitleScore(title) {
    const text = cleanupAlbumEntryTitle(title);
    if (!text) return 0;
    const normalized = normalizeSeriesText(text);
    if (!normalized) return 0;
    let score = Math.min(text.length, 80);
    if (/[\u3400-\u9fff]/.test(text)) score += 20;
    if (/催|眠|性|指導|指导|secret|lesson/i.test(text)) score += 20;
    if (/^\d+$/.test(text) || /^(封面|下一页|後頁|前頁|详情|詳情)$/i.test(text)) score -= 40;
    return score;
  }

  /**
   * 提取作品序号（用于系列排序）
   * @param {string} title
   * @returns {number} 序号，无法识别时返回 Infinity
   */
  function extractSeriesOrderValue(title) {
    const text = cleanupAlbumEntryTitle(title);
    if (!text) return Number.POSITIVE_INFINITY;

    const regexes = [
      /第\s*(\d+(?:\.\d+)?)\s*[话話回卷章部冊集篇]/i,
      /(\d+(?:\.\d+)?)\s*[话話回卷章部冊集篇]/i,
      /(?:vol(?:ume)?|v)\.?\s*(\d+(?:\.\d+)?)/i,
      /(?:part|pt)\.?\s*(\d+(?:\.\d+)?)/i,
      /#\s*(\d+(?:\.\d+)?)/i
    ];

    for (const re of regexes) {
      const m = text.match(re);
      if (!m) continue;
      const num = Number(m[1]);
      if (Number.isFinite(num)) return num;
    }

    const simplified = text
      .replace(/\[[^\]]*\]|【[^】]*】|（[^）]*）|\([^)]*\)/g, ' ')
      .replace(/\b(?:c|C)\d{2,3}\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const anchored = simplified.match(/(?:催眠\s*性\s*指導|secret\s*lesson)\s*[-–—:：~～]?\s*(\d+(?:\.\d+)?)/i);
    if (anchored) {
      const num = Number(anchored[1]);
      if (Number.isFinite(num)) return num;
    }

    const standalone = Array.from(simplified.matchAll(/(?:^|[^\d])(\d{1,2}(?:\.\d+)?)(?=[^\d]|$)/g))
      .map((m) => Number(m[1]))
      .filter((n) => Number.isFinite(n) && n > 0 && n <= 50);
    if (standalone.length > 0) return standalone[0];

    return Number.POSITIVE_INFINITY;
  }

  /**
   * 构造“同作品”去重键，保留章节序号信息
   * @param {string} title
   * @param {string} keyword
   * @returns {string}
   */
  function buildSeriesWorkKey(title, keyword = '') {
    const normalizedKeyword = normalizeSeriesText(keyword).replace(/[●○◎◆◇□■＊*･・]/g, '');
    let text = cleanupAlbumEntryTitle(title);

    text = text
      .replace(/\[[^\]]*\]|【[^】]*】|（[^）]*）|\([^)]*\)/g, ' ')
      .replace(/\b(?:c|C)\d{2,3}\b/g, ' ')
      .replace(/(?:中国翻訳|中國翻譯|汉化|漢化|個人漢化|个人汉化|翻译|翻譯|機翻|机翻|無修正|无修正|dl版|digital|補檔|补档|重傳|重传|轉載|转载|搬运|搬運|熟肉|修正版?)/gi, ' ');

    let key = normalizeSeriesText(text).replace(/[●○◎◆◇□■＊*･・]/g, '');
    if (normalizedKeyword && key.includes(normalizedKeyword)) {
      key = key.replace(normalizedKeyword, '');
    }

    if (!key || key.length < 3) {
      key = normalizeSeriesText(title).replace(/[●○◎◆◇□■＊*･・]/g, '');
    }

    return key.slice(0, 120);
  }

  /**
   * 系列结果去重并排序：先按章节序号，再按质量分
   * @param {Array<{aid:number,title:string,url:string}>} items
   * @param {string} keyword
   * @returns {Array<{aid:number,title:string,url:string}>}
   */
  function dedupeAndSortSeriesItems(items, keyword) {
    const grouped = new Map();

    for (const item of items) {
      const key = buildSeriesWorkKey(item.title, keyword) || `aid_${item.aid}`;
      const order = extractSeriesOrderValue(item.title);
      const affinity = Number(item._affinity || 0);
      const qualityScore = getAlbumEntryTitleScore(item.title) + (matchesSeriesKeyword(item.title, keyword) ? 25 : 0) + affinity;
      const current = { ...item, _order: order, _score: qualityScore };
      const prev = grouped.get(key);

      if (!prev) {
        grouped.set(key, current);
        continue;
      }

      if ((current._score || 0) > (prev._score || 0)) {
        grouped.set(key, current);
      } else if ((current._score || 0) === (prev._score || 0) && current.aid > prev.aid) {
        grouped.set(key, current);
      }
    }

    return Array.from(grouped.values())
      .sort((a, b) => {
        const ao = Number.isFinite(a._order) ? a._order : Number.POSITIVE_INFINITY;
        const bo = Number.isFinite(b._order) ? b._order : Number.POSITIVE_INFINITY;
        if (ao !== bo) return ao - bo;
        if ((b._score || 0) !== (a._score || 0)) return (b._score || 0) - (a._score || 0);
        return b.aid - a.aid;
      })
      .map(({ aid, title, url }) => ({ aid, title, url }));
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

      const rawTitleCandidates = [
        (link.getAttribute('title') || '').trim(),
        (link.querySelector('img')?.getAttribute('alt') || '').trim(),
        (link.textContent || '').trim()
      ];
      const title = rawTitleCandidates
        .map((raw) => cleanupAlbumEntryTitle(raw))
        .find((text) => text.length >= 2) || '';
      const titleScore = getAlbumEntryTitleScore(title);
      const url = `${location.origin}/photos-index-aid-${aid}.html`;

      if (!map.has(aid)) {
        map.set(aid, { aid, title, url, _score: titleScore });
      } else if (title && titleScore > (map.get(aid)._score || 0)) {
        map.set(aid, { aid, title, url, _score: titleScore });
      }

      if (map.size >= maxItems) break;
    }

    return Array.from(map.values()).map(({ aid, title, url }) => ({ aid, title, url }));
  }

  /**
   * 从列表页中查找“后页”链接（通用）
   * @param {Document} doc
   * @returns {string|null}
   */
  function findNextPageUrl(doc) {
    const links = Array.from(doc.querySelectorAll('a[href]'));
    const next = links.find((a) => {
      const text = String(a.textContent || '').trim();
      if (/(?:後頁|后页|下一頁|下一页|next)/i.test(text)) return true;
      const cls = String(a.className || '');
      if (/next/i.test(cls)) return true;
      return false;
    });
    if (!next) return null;
    const href = next.getAttribute('href') || next.href || '';
    if (!href) return null;
    try {
      return new URL(href, location.origin).toString();
    } catch {
      return null;
    }
  }

  /**
   * 从某个列表入口分页抓取相册条目
   * @param {string} startUrl
   * @param {number} maxPages
   * @param {number} maxItems
   * @returns {Promise<Array<{aid:number,title:string,url:string}>>}
   */
  async function collectAlbumEntriesFromPagedUrl(startUrl, maxPages = 4, maxItems = 300) {
    const map = new Map();
    const visited = new Set();
    let currentUrl = startUrl;

    for (let page = 0; page < maxPages; page += 1) {
      if (!currentUrl || visited.has(currentUrl)) break;
      visited.add(currentUrl);

      const doc = await fetchHtmlDocument(currentUrl);
      if (!doc) break;

      const pageItems = collectAlbumEntriesFromDoc(doc, maxItems);
      for (const item of pageItems) {
        const score = getAlbumEntryTitleScore(item.title);
        const prev = map.get(item.aid);
        if (!prev || score > (prev._score || 0)) {
          map.set(item.aid, { ...item, _score: score });
        }
      }

      if (map.size >= maxItems) break;
      const nextUrl = findNextPageUrl(doc);
      if (!nextUrl || visited.has(nextUrl)) break;
      currentUrl = nextUrl;
    }

    return Array.from(map.values()).map(({ aid, title, url }) => ({ aid, title, url }));
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
    const keywordCandidates = buildSeriesKeywordCandidates(currentTitle, customKeyword);
    const firstKeyword = keywordCandidates[0] || '';

    if (!firstKeyword && !forceShow) {
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
    keywordEl.textContent = firstKeyword || '未识别';
    titleEl.appendChild(keywordEl);

    const loadingEl = document.createElement('div');
    loadingEl.className = 'wnacg-series-loading';
    loadingEl.textContent = firstKeyword ? '正在检索系列作品...' : '未识别到系列关键词，请使用“系列作品”按钮手动输入。';

    const metaEl = document.createElement('div');
    metaEl.className = 'wnacg-series-meta';
    metaEl.textContent = '';

    panel.appendChild(titleEl);
    panel.appendChild(metaEl);
    panel.appendChild(loadingEl);

    const anchor = document.getElementById('wnacg-album-oneclick')
      || document.querySelector('a[href*="download-index-aid-"]');
    const host = anchor?.closest('.wnacg-album-action-row, .download_btns, .ads, .asTB') || anchor?.parentElement || document.body;
    const wideHost = document.querySelector('.asTB') || document.querySelector('.uwconn');
    if (wideHost && wideHost.parentElement) {
      wideHost.insertAdjacentElement('afterend', panel);
    } else if (host && host.parentElement) {
      host.insertAdjacentElement('afterend', panel);
    } else {
      document.body.insertBefore(panel, document.body.firstChild);
    }

    if (keywordCandidates.length === 0) return;

    const authorTagCandidates = selectAuthorTagCandidates(currentTitle, keywordCandidates, 2);
    if (authorTagCandidates.length > 0) {
      log(`系列检索作者候选：${authorTagCandidates.map((item) => `${item.name}(${item.score})`).join(', ')}`);
    }

    try {
      let selectedKeyword = '';
      let items = [];
      let rawMatchedCount = 0;
      let hasRequestError = false;
      let selectedSource = '';
      let selectedAuthorTag = '';

      const getValidKeywords = () => keywordCandidates.filter((candidate) => {
        const normalizedKeyword = normalizeSeriesText(candidate);
        const isCjkKeyword = /[\u3400-\u9fff]/.test(normalizedKeyword);
        const minLen = isCjkKeyword ? 2 : 3;
        return Boolean(normalizedKeyword && normalizedKeyword.length >= minLen);
      });
      const validKeywords = buildValidSeriesKeywords(getValidKeywords(), currentTitle, customKeyword);
      if (validKeywords.length === 0) {
        keywordEl.textContent = firstKeyword || '未识别';
        loadingEl.textContent = '未识别到有效系列关键词，请点击“系列作品”按钮手动输入。';
        return;
      }

      // 优先：同作者标签页检索（用户要求）
      for (const authorTag of authorTagCandidates) {
        loadingEl.textContent = `正在同作者标签“${authorTag.name}”中检索...`;

        const authorItems = await collectAlbumEntriesFromPagedUrl(authorTag.url, 5, 420);
        if (authorItems.length === 0) {
          hasRequestError = true;
          continue;
        }

        for (const candidate of validKeywords) {
          keywordEl.textContent = candidate;
          loadingEl.textContent = `正在同作者标签“${authorTag.name}”中匹配关键词：${candidate}`;

          const rawMatched = authorItems
            .filter((item) => item.aid !== currentAid)
            .filter((item) => matchesSeriesKeyword(item.title, candidate));
          const threshold = /[\u3400-\u9fff]/.test(normalizeSeriesText(candidate)) ? 62 : 68;
          const affinityMatched = rawMatched
            .map((item) => ({
              ...item,
              _affinity: computeSeriesAffinityScore(currentTitle, item.title, candidate)
            }))
            .filter((item) => item._affinity >= threshold);
          const matched = dedupeAndSortSeriesItems(affinityMatched, candidate).slice(0, 16);

          if (matched.length > 0) {
            selectedKeyword = candidate;
            items = matched;
            rawMatchedCount = affinityMatched.length;
            selectedSource = '同作者标签';
            selectedAuthorTag = authorTag.name;
            break;
          }
        }

        if (items.length > 0) break;
      }

      // 回退：站内搜索
      if (items.length === 0) {
        for (const candidate of validKeywords) {
          keywordEl.textContent = candidate;
          loadingEl.textContent = `正在站内搜索（关键词：${candidate}）...`;

          const searchUrl = `${location.origin}/search/index.php?q=${encodeURIComponent(candidate)}`;
          const searchDoc = await fetchHtmlDocument(searchUrl);
          if (!searchDoc) {
            hasRequestError = true;
            continue;
          }

          const rawMatched = collectAlbumEntriesFromDoc(searchDoc, 160)
            .filter((item) => item.aid !== currentAid)
            .filter((item) => matchesSeriesKeyword(item.title, candidate));
          const threshold = /[\u3400-\u9fff]/.test(normalizeSeriesText(candidate)) ? 62 : 68;
          const affinityMatched = rawMatched
            .map((item) => ({
              ...item,
              _affinity: computeSeriesAffinityScore(currentTitle, item.title, candidate)
            }))
            .filter((item) => item._affinity >= threshold);
          const matched = dedupeAndSortSeriesItems(affinityMatched, candidate).slice(0, 16);

          if (matched.length > 0) {
            selectedKeyword = candidate;
            items = matched;
            rawMatchedCount = affinityMatched.length;
            selectedSource = '站内搜索';
            selectedAuthorTag = '';
            break;
          }
        }
      }

      if (items.length === 0) {
        keywordEl.textContent = firstKeyword || '未识别';
        loadingEl.textContent = hasRequestError
          ? '检索失败：请点击“系列作品”按钮手动重试。'
          : '未找到同系列作品。可点击“系列作品”按钮手动更换关键词。';
        return;
      }

      keywordEl.textContent = selectedKeyword || firstKeyword;
      const sourceText = selectedSource === '同作者标签'
        ? `来源：${selectedSource}（${selectedAuthorTag}）`
        : `来源：${selectedSource || '未知'}`;
      metaEl.textContent = `${sourceText} · 已按章节优先排序，去重后 ${items.length} 部（原始 ${rawMatchedCount} 条）`;

      const list = document.createElement('ul');
      list.className = 'wnacg-series-list';

      for (const item of items) {
        const li = document.createElement('li');
        li.className = 'wnacg-series-item';

        const a = document.createElement('a');
        a.href = item.url;
        a.textContent = item.title || `相册 ${item.aid}`;
        a.target = '_self';

        const sub = document.createElement('div');
        sub.className = 'wnacg-series-submeta';
        const order = extractSeriesOrderValue(item.title);
        const orderLabel = Number.isFinite(order) ? `序号 ${order}` : '序号 未识别';
        sub.textContent = `${orderLabel} · aid ${item.aid}`;

        li.appendChild(a);
        li.appendChild(sub);
        list.appendChild(li);
      }

      const loading = panel.querySelector('.wnacg-series-loading');
      if (loading) loading.remove();
      panel.appendChild(list);
      log(`系列作品面板加载完成，共 ${items.length} 项（来源：${selectedSource}${selectedAuthorTag ? `/${selectedAuthorTag}` : ''}，去重前 ${rawMatchedCount}，关键词：${selectedKeyword || firstKeyword}）`);
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
   * 刷新进度面板标题（移动端最小化时显示进度摘要）
   */
  function refreshProgressPanelTitle() {
    const titleEl = STATE.ui.progressTitle;
    if (!titleEl) return;
    const baseTitle = titleEl.dataset.baseTitle || 'WNACG 批量下载';
    if (STATE.ui.minimized && isMobileUI) {
      const short = String(STATE.ui.progressText?.textContent || '').trim().split(' ')[0] || '';
      titleEl.textContent = short ? `${baseTitle} ${short}` : baseTitle;
      return;
    }
    titleEl.textContent = baseTitle;
  }

  /**
   * 统一切换进度面板最小化状态
   * @param {boolean} minimized
   */
  function applyProgressPanelMinimized(minimized) {
    STATE.ui.minimized = Boolean(minimized);
    const hide = STATE.ui.minimized;
    STATE.ui.progressPanel?.classList.toggle('wnacg-minimized', hide);
    if (STATE.ui.progressBar) STATE.ui.progressBar.style.display = hide ? 'none' : '';
    if (STATE.ui.progressText) STATE.ui.progressText.style.display = hide ? 'none' : '';
    if (STATE.ui.logBox) STATE.ui.logBox.style.display = hide ? 'none' : '';
    if (STATE.ui.pauseBtn) STATE.ui.pauseBtn.style.display = hide ? 'none' : '';
    if (STATE.ui.clearQueueBtn) STATE.ui.clearQueueBtn.style.display = hide ? 'none' : '';
    if (STATE.ui.minimizeBtn) STATE.ui.minimizeBtn.textContent = hide ? '展开' : '最小化';
    refreshProgressPanelTitle();
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
    title.dataset.baseTitle = 'WNACG 批量下载';

    const bar = document.createElement('div');
    bar.className = 'wnacg-progress-bar';
    const fill = document.createElement('div');
    fill.className = 'wnacg-progress-fill';
    fill.style.width = '0%';
    bar.appendChild(fill);

    const text = document.createElement('div');
    text.className = 'wnacg-progress-text';
    text.textContent = '0/0';
    text.setAttribute('aria-live', 'polite');

    const logBox = document.createElement('div');
    logBox.className = 'wnacg-progress-log';
    logBox.setAttribute('role', 'log');
    logBox.setAttribute('aria-live', 'polite');

    const actions = document.createElement('div');
    actions.className = 'wnacg-progress-actions';

    const pauseBtn = document.createElement('button');
    pauseBtn.className = 'wnacg-batch-btn';
    pauseBtn.textContent = '暂停';

    const clearQueueBtn = document.createElement('button');
    clearQueueBtn.className = 'wnacg-batch-btn wnacg-btn-danger';
    clearQueueBtn.textContent = '清空队列';

    const minimizeBtn = document.createElement('button');
    minimizeBtn.className = 'wnacg-batch-btn wnacg-btn-secondary';
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
      applyProgressPanelMinimized(!STATE.ui.minimized);
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
    STATE.ui.progressTitle = title;
    STATE.ui.progressBar = bar;
    STATE.ui.progressFill = fill;
    STATE.ui.progressText = text;
    STATE.ui.logBox = logBox;
    STATE.ui.pauseBtn = pauseBtn;
    STATE.ui.clearQueueBtn = clearQueueBtn;
    STATE.ui.minimizeBtn = minimizeBtn;

    // 移动端默认最小化，避免遮挡内容
    if (isMobileUI) {
      applyProgressPanelMinimized(true);
    } else {
      refreshProgressPanelTitle();
    }
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
    refreshProgressPanelTitle();
  }

  /**
   * 创建新的下载队列并绑定进度面板
   */
  function createDownloadQueue() {
    ensureProgressPanel();
    if (!isMobileUI && STATE.ui.minimized) {
      applyProgressPanelMinimized(false);
    }
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
        btnSelectAll.className = 'wnacg-batch-btn wnacg-btn-secondary';
        btnSelectAll.textContent = '全选';

        const btnInvert = document.createElement('button');
        btnInvert.className = 'wnacg-batch-btn wnacg-btn-secondary';
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
        btnExitSelectMode.className = 'wnacg-batch-btn wnacg-btn-danger wnacg-exit-mode-btn';
        btnExitSelectMode.textContent = '退出选择模式';

        const btnClearSelection = document.createElement('button');
        btnClearSelection.className = 'wnacg-batch-btn wnacg-btn-secondary';
        btnClearSelection.textContent = '清空选择';

        const btnSelectAll = document.createElement('button');
        btnSelectAll.className = 'wnacg-batch-btn wnacg-btn-secondary';
        btnSelectAll.textContent = '全选';

        const btnInvert = document.createElement('button');
        btnInvert.className = 'wnacg-batch-btn wnacg-btn-secondary';
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
   * 确保相册页按钮在同一行动作栏中对齐
   * @param {HTMLElement|null} referenceEl
   * @returns {HTMLElement|null}
   */
  function ensureAlbumActionRow(referenceEl) {
    if (!referenceEl) return null;
    const row = referenceEl.closest('.wnacg-album-action-row');
    if (row) return row;

    const parent = referenceEl.parentElement;
    if (!parent) return null;

    if (parent.classList.contains('download_btns') || parent.querySelector('a[href*="download-index-aid-"]')) {
      parent.classList.add('wnacg-album-action-row');
      return parent;
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'wnacg-album-action-row';
    parent.insertBefore(wrapper, referenceEl);
    wrapper.appendChild(referenceEl);
    return wrapper;
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

    const actionRow = ensureAlbumActionRow(referenceEl);
    if (actionRow) {
      actionRow.appendChild(findBtn);
    } else if (referenceEl && referenceEl.parentElement) {
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
        ensureAlbumActionRow(oneClickExisting || document.querySelector('a[href*="download-index-aid-"]'));
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

      const actionRow = ensureAlbumActionRow(downloadBtn);
      if (actionRow) {
        actionRow.appendChild(oneClick);
      } else if (downloadBtn && downloadBtn.parentElement) {
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
