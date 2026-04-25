import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import { getLogitDir, getRepoRoot } from '../core/repository.js';
import { readObject, objectExists, listAllObjects, writeObject } from '../core/objects.js';
import { getAllRefs, getBranchCommit, resolveHead } from '../core/refs.js';
import { getCommitLog, readCommit } from '../core/commit.js';
import { readTree } from '../core/tree.js';
import { createPackfile, unpackPackfile } from '../core/packfile.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const Diff = require('diff');

// ---------------------------------------------------------------------------
// Auth middleware factory
// ---------------------------------------------------------------------------
function makeAuthMiddleware(token, readOnly) {
  return function authMiddleware(req, res, next) {
    const isWriteRoute = req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE';

    if (readOnly && isWriteRoute) {
      return res.status(403).json({ error: 'Server is in read-only mode. Writes are not allowed.' });
    }

    if (token && isWriteRoute) {
      const authHeader = req.headers['authorization'] || '';
      const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
      if (provided !== token) {
        return res.status(401).json({ error: 'Unauthorized: invalid or missing token.' });
      }
    }

    next();
  };
}

// ---------------------------------------------------------------------------
// Web Explorer UI (self-contained HTML/CSS/JS)
// ---------------------------------------------------------------------------
function buildWebUI(repoName) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${repoName} — Logit Explorer</title>
  <link href="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism-tomorrow.min.css" rel="stylesheet" />
  <style>
    :root {
      --bg: #0d1117; --bg2: #161b22; --bg3: #21262d;
      --border: #30363d; --text: #e6edf3; --muted: #8b949e;
      --accent: #7c3aed; --accent2: #a78bfa; --green: #3fb950;
      --yellow: #d29922; --red: #f85149; --blue: #58a6ff;
      --orange: #f0883e;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; font-size: 14px; min-height: 100vh; }

    header { background: var(--bg2); border-bottom: 1px solid var(--border); padding: 12px 24px; display: flex; align-items: center; gap: 16px; position: sticky; top: 0; z-index: 100; backdrop-filter: blur(10px); }
    .logo { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 16px; color: var(--accent2); text-decoration: none; }
    .logo svg { width: 22px; height: 22px; }
    .repo-name { color: var(--text); font-size: 15px; font-weight: 600; }
    
    .header-actions { margin-left: auto; display: flex; gap: 12px; align-items: center; }
    select#branch-select { background: var(--bg3); color: var(--text); border: 1px solid var(--border); padding: 4px 8px; border-radius: 6px; font-size: 13px; outline: none; cursor: pointer; }

    .layout { display: grid; grid-template-columns: 280px 1fr; min-height: calc(100vh - 57px); }
    .sidebar { background: var(--bg2); border-right: 1px solid var(--border); padding: 16px; overflow-y: auto; }
    .main { padding: 24px; overflow: auto; }

    /* File Tree */
    .sidebar-section { margin-bottom: 24px; }
    .sidebar-title { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin-bottom: 8px; padding: 0 4px; }
    .file-tree, .folder-children { list-style: none; }
    .folder-children { margin-left: 14px; border-left: 1px solid var(--border); padding-left: 4px; display: none; }
    .folder-children.open { display: block; }
    .file-item { display: flex; align-items: center; gap: 6px; padding: 5px 8px; border-radius: 6px; cursor: pointer; transition: background .15s; font-size: 13px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .file-item:hover { background: var(--bg3); }
    .file-item.active { background: rgba(124,58,237,.2); color: var(--accent2); }
    .file-icon { flex-shrink: 0; font-size: 12px; }

    /* Commits */
    .commits-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
    .commits-header h2 { font-size: 16px; font-weight: 600; }
    .commit-count { background: var(--bg3); border: 1px solid var(--border); border-radius: 20px; padding: 2px 10px; font-size: 12px; color: var(--muted); }
    .commit-search { padding: 6px 12px; background: var(--bg3); border: 1px solid var(--border); border-radius: 6px; color: var(--text); width: 200px; font-size: 13px; }

    .commit-graph { position: relative; }
    .commit-card { display: grid; grid-template-columns: 40px 1fr; gap: 0; position: relative; }
    .commit-line { display: flex; flex-direction: column; align-items: center; }
    .commit-dot { width: 12px; height: 12px; border-radius: 50%; background: var(--accent); border: 2px solid var(--bg2); flex-shrink: 0; margin-top: 14px; z-index: 1; position: relative; box-shadow: 0 0 0 3px rgba(124,58,237,.25); }
    .commit-connector { width: 2px; flex: 1; background: var(--border); margin-top: 0; }
    .commit-card:last-child .commit-connector { display: none; }

    .commit-body { background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; margin: 8px 0 8px 0; cursor: pointer; transition: border-color .15s, box-shadow .15s; }
    .commit-body:hover { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(124,58,237,.1); }
    .commit-msg { font-weight: 600; font-size: 14px; margin-bottom: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .commit-meta { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
    .commit-hash-wrapper { display: inline-flex; align-items: center; background: var(--bg3); border: 1px solid var(--border); border-radius: 4px; padding: 1px 2px 1px 6px; }
    .commit-hash { font-family: 'SFMono-Regular', Consolas, monospace; font-size: 12px; color: var(--accent2); }
    .copy-btn { background: transparent; border: none; color: var(--muted); cursor: pointer; padding: 2px 4px; border-radius: 4px; display: inline-flex; align-items: center; justify-content: center; transition: all 0.15s; margin-left: 4px; }
    .copy-btn:hover { background: var(--bg); color: var(--text); }
    .copy-btn:active { transform: scale(0.85); color: var(--accent2); }
    .copy-btn svg { width: 12px; height: 12px; }
    .commit-author { color: var(--muted); font-size: 12px; }
    .commit-date { color: var(--muted); font-size: 12px; }
    .tag-badge { background: rgba(240,136,62,.15); border: 1px solid var(--orange); color: var(--orange); border-radius: 4px; padding: 1px 6px; font-size: 11px; }

    /* Toast */
    .toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%) translateY(20px); background: var(--accent); color: white; padding: 8px 16px; border-radius: 20px; font-weight: 600; font-size: 13px; opacity: 0; pointer-events: none; transition: opacity 0.2s, transform 0.2s; z-index: 1000; box-shadow: 0 4px 12px rgba(0,0,0,0.2); }
    .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }

    /* Diffs */
    .commit-diff-container { margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--border); display: none; }
    .commit-diff-container.open { display: block; }
    .diff-file { margin-bottom: 8px; }
    .diff-filename { font-size: 12px; font-family: monospace; font-weight: bold; margin-bottom: 4px; color: var(--accent2); }
    .diff-patch { background: var(--bg); padding: 8px; border-radius: 4px; font-family: monospace; font-size: 11px; white-space: pre-wrap; word-break: break-all; overflow-x: auto; }
    .diff-add { color: var(--green); }
    .diff-del { color: var(--red); }

    /* File viewer */
    .file-viewer { background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
    .file-viewer-header { padding: 10px 16px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; background: var(--bg3); }
    .file-path { font-family: monospace; font-size: 13px; color: var(--accent2); }
    .file-size { color: var(--muted); font-size: 12px; }
    pre { padding: 16px; overflow: auto; font-size: 13px; line-height: 1.6; max-height: 600px; margin: 0; }

    /* Stats bar */
    .stats-bar { display: flex; gap: 16px; margin-bottom: 24px; }
    .stat-card { background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 16px 20px; flex: 1; display: flex; flex-direction: column; gap: 4px; transition: border-color .15s; }
    .stat-card:hover { border-color: var(--accent); }
    .stat-value { font-size: 24px; font-weight: 700; color: var(--accent2); }
    .stat-label { font-size: 12px; color: var(--muted); }

    /* Tabs */
    .tabs { display: flex; gap: 4px; margin-bottom: 20px; border-bottom: 1px solid var(--border); }
    .tab { padding: 8px 16px; cursor: pointer; color: var(--muted); font-size: 14px; border-bottom: 2px solid transparent; transition: color .15s, border-color .15s; margin-bottom: -1px; }
    .tab:hover { color: var(--text); }
    .tab.active { color: var(--accent2); border-bottom-color: var(--accent); }

    .loading { text-align: center; padding: 48px; color: var(--muted); }
    .spinner { display: inline-block; width: 24px; height: 24px; border: 3px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin .8s linear infinite; margin-bottom: 12px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .empty { text-align: center; padding: 48px; color: var(--muted); }
    
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
  </style>
</head>
<body>
  <header>
    <a class="logo" href="#">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/>
      </svg>
      Logit
    </a>
    <span class="repo-name">${repoName}</span>
    
    <div class="header-actions">
      <select id="branch-select" onchange="switchRef(this.value)">
        <option value="">Loading...</option>
      </select>
    </div>
  </header>

  <div class="layout">
    <aside class="sidebar">
      <div class="sidebar-section">
        <div class="sidebar-title">Files</div>
        <ul class="file-tree" id="file-tree">
          <li class="loading"><div class="spinner"></div></li>
        </ul>
      </div>
    </aside>

    <main class="main">
      <div class="stats-bar" id="stats-bar"></div>

      <div class="tabs">
        <div class="tab active" data-tab="commits" id="tab-commits">Commits</div>
        <div class="tab" data-tab="file" id="tab-file">File Viewer</div>
      </div>

      <div id="view-commits">
        <div class="commits-header">
          <h2>Commit History</h2>
          <div style="display:flex; gap:12px; align-items:center;">
            <input type="text" id="commit-search" class="commit-search" placeholder="Search commits..." oninput="handleSearch()" />
            <span class="commit-count" id="commit-count">—</span>
          </div>
        </div>
        <div class="commit-graph" id="commit-graph">
          <div class="loading"><div class="spinner"></div><br>Loading commits…</div>
        </div>
      </div>

      <div id="view-file" style="display:none">
        <div id="file-content-area">
          <div class="empty">← Select a file from the sidebar to view its contents.</div>
        </div>
      </div>
    </main>
  </div>

  <div id="toast" class="toast">Copied!</div>

  <script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/prism.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-javascript.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-json.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-markdown.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-bash.min.js"></script>

  <script>
    const API = '';
    let allCommits = [];
    let tags = {};
    let currentRef = '';

    // Tabs
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('view-commits').style.display = tab.dataset.tab === 'commits' ? '' : 'none';
        document.getElementById('view-file').style.display = tab.dataset.tab === 'file' ? '' : 'none';
      });
    });

    // Load info
    async function loadInfo(ref = '') {
      currentRef = ref;
      document.getElementById('commit-graph').innerHTML = '<div class="loading"><div class="spinner"></div></div>';
      document.getElementById('file-tree').innerHTML = '<li class="loading"><div class="spinner"></div></li>';

      const qs = ref ? '?ref=' + encodeURIComponent(ref) : '';

      const [infoRes, commitsRes, tagsRes, fileRes] = await Promise.all([
        fetch(API + '/info'),
        fetch(API + '/ui/commits' + qs),
        fetch(API + '/ui/tags'),
        fetch(API + '/ui/tree' + qs)
      ]);

      const info = await infoRes.json();
      allCommits = await commitsRes.json();
      tags = await tagsRes.json();
      const files = await fileRes.json();

      // Populate Branch/Tag dropdown
      const select = document.getElementById('branch-select');
      if (select.options.length <= 1) { // Only populate once
        select.innerHTML = '';
        const branchesOptGroup = document.createElement('optgroup');
        branchesOptGroup.label = "Branches";
        for (const r of Object.keys(info.refs || {})) {
          if (r.startsWith('refs/heads/')) {
            const b = r.replace('refs/heads/', '');
            const opt = new Option(b, r);
            if (!ref && info.refs[r] === info.head) opt.selected = true;
            branchesOptGroup.appendChild(opt);
          }
        }
        select.appendChild(branchesOptGroup);
        
        const tagsOptGroup = document.createElement('optgroup');
        tagsOptGroup.label = "Tags";
        for (const t of Object.keys(tags)) {
          tagsOptGroup.appendChild(new Option(t, 'refs/tags/'+t));
        }
        select.appendChild(tagsOptGroup);

        if (!ref && info.head) {
          // Default selection to whatever matches head if nothing specified
          for(const r of Object.keys(info.refs || {})) {
            if (info.refs[r] === info.head) {
               currentRef = r;
               select.value = r;
               break;
            }
          }
        }
      }

      // Stats
      const branchCount = Object.keys(info.refs || {}).length;
      const tagCount = Object.keys(tags).length;
      document.getElementById('stats-bar').innerHTML = [
        { label: 'Commits', value: allCommits.length, icon: '●' },
        { label: 'Branches', value: branchCount, icon: '⑂' },
        { label: 'Tags', value: tagCount, icon: '⬡' },
        { label: 'Files', value: files.length, icon: '◻' }
      ].map(s => \`
        <div class="stat-card">
          <div class="stat-value">\${s.value}</div>
          <div class="stat-label">\${s.label}</div>
        </div>
      \`).join('');

      renderCommits(allCommits, tags);
      renderFileTree(files);
    }

    function switchRef(newRef) {
      loadInfo(newRef);
    }

    function handleSearch() {
      const q = document.getElementById('commit-search').value.toLowerCase();
      const filtered = allCommits.filter(c => 
        (c.message && c.message.toLowerCase().includes(q)) || 
        (c.author && c.author.toLowerCase().includes(q)) || 
        (c.hash && c.hash.toLowerCase().includes(q))
      );
      renderCommits(filtered, tags);
    }

    // Commits
    function timeAgo(ts) {
      const diff = Date.now() - ts;
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return 'just now';
      if (mins < 60) return mins + 'm ago';
      const hours = Math.floor(mins / 60);
      if (hours < 24) return hours + 'h ago';
      return Math.floor(hours / 24) + 'd ago';
    }

    function renderCommits(commits, tags) {
      document.getElementById('commit-count').textContent = commits.length + ' commit' + (commits.length !== 1 ? 's' : '');

      if (commits.length === 0) {
        document.getElementById('commit-graph').innerHTML = '<div class="empty">No commits found.</div>';
        return;
      }

      const tagsByHash = {};
      for (const [name, hash] of Object.entries(tags)) {
        if (!tagsByHash[hash]) tagsByHash[hash] = [];
        tagsByHash[hash].push(name);
      }

      document.getElementById('commit-graph').innerHTML = commits.map((c, i) => {
        const tagBadges = (tagsByHash[c.hash] || []).map(t => \`<span class="tag-badge">⬡ \${t}</span>\`).join(' ');
        return \`
          <div class="commit-card">
            <div class="commit-line">
              <div class="commit-dot"></div>
              \${i < commits.length - 1 ? '<div class="commit-connector"></div>' : ''}
            </div>
            <div class="commit-body" onclick="toggleCommitDiff('\${c.hash}')">
              <div class="commit-msg">\${escHtml(c.message)} \${tagBadges}</div>
              <div class="commit-meta">
                <div class="commit-hash-wrapper" onclick="event.stopPropagation()">
                  <span class="commit-hash">\${c.hash.substring(0,7)}</span>
                  <button class="copy-btn" onclick="copyHash('\${c.hash}')" title="Copy full hash">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                  </button>
                </div>
                <span class="commit-author">\${escHtml(c.author)}</span>
                <span class="commit-date">\${timeAgo(c.timestamp)}</span>
              </div>
              <div id="diff-\${c.hash}" class="commit-diff-container">
                 <div class="loading"><div class="spinner"></div></div>
              </div>
            </div>
          </div>
        \`;
      }).join('');
    }

    function copyHash(hash) {
      navigator.clipboard?.writeText(hash);
      const toast = document.getElementById('toast');
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 2000);
    }

    async function toggleCommitDiff(hash) {
      const container = document.getElementById('diff-' + hash);
      if (container.classList.contains('open')) {
        container.classList.remove('open');
        return;
      }
      
      container.classList.add('open');
      if (container.dataset.loaded) return; 
      
      try {
        const res = await fetch(API + '/ui/commit/' + hash + '/diff');
        if (!res.ok) throw new Error('Failed to load diff');
        const diffs = await res.json();
        
        if (diffs.length === 0) {
          container.innerHTML = '<div style="color:var(--muted); font-size:12px;">No file changes in this commit.</div>';
        } else {
          container.innerHTML = diffs.map(d => {
            const htmlPatch = escHtml(d.patch).replace(/^(\\+.*)$/gm, '<span class="diff-add">$1</span>')
                                               .replace(/^(-.*)$/gm, '<span class="diff-del">$1</span>');
            return \`
              <div class="diff-file">
                <div class="diff-filename">\${escHtml(d.file)}</div>
                <div class="diff-patch">\${htmlPatch}</div>
              </div>
            \`;
          }).join('');
        }
        container.dataset.loaded = 'true';
      } catch (e) {
        container.innerHTML = '<div style="color:var(--red); font-size:12px;">Error loading diff</div>';
      }
    }

    // File tree
    function renderFileTree(files) {
      if (files.length === 0) {
        document.getElementById('file-tree').innerHTML = '<li style="color:var(--muted);padding:8px 4px;font-size:12px">No files</li>';
        return;
      }
      
      const root = {};
      for (const f of files) {
        const parts = f.split('/');
        let curr = root;
        for (let i = 0; i < parts.length; i++) {
          const p = parts[i];
          if (!curr[p]) curr[p] = i === parts.length - 1 ? f : {};
          curr = curr[p];
        }
      }

      function buildHtml(node) {
        let html = '';
        const keys = Object.keys(node).sort((a,b) => {
          const aIsDir = typeof node[a] === 'object';
          const bIsDir = typeof node[b] === 'object';
          if (aIsDir && !bIsDir) return -1;
          if (!aIsDir && bIsDir) return 1;
          return a.localeCompare(b);
        });

        for (const k of keys) {
          if (typeof node[k] === 'object') {
            html += \`
              <li>
                <div class="file-item" onclick="this.nextElementSibling.classList.toggle('open')">
                  <span class="file-icon">📁</span>
                  <span>\${escHtml(k)}</span>
                </div>
                <ul class="folder-children open">\${buildHtml(node[k])}</ul>
              </li>
            \`;
          } else {
            html += \`
              <li class="file-item" onclick="viewFile('\${escHtml(node[k])}')">
                <span class="file-icon">\${getIcon(k)}</span>
                <span title="\${escHtml(node[k])}">\${escHtml(k)}</span>
              </li>
            \`;
          }
        }
        return html;
      }

      document.getElementById('file-tree').innerHTML = buildHtml(root);
    }

    function getIcon(name) {
      const ext = name.split('.').pop().toLowerCase();
      const map = { js:'🟨', ts:'🔷', json:'📋', md:'📝', txt:'📄', css:'🎨', html:'🌐', sh:'⚙', env:'🔑', py:'🐍', yml:'⚙', yaml:'⚙' };
      return map[ext] || '📄';
    }

    // View file
    async function viewFile(filePath) {
      document.querySelectorAll('.file-item').forEach(el => {
        el.classList.toggle('active', el.querySelector('span:last-child').textContent === filePath.split('/').pop());
      });

      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.getElementById('tab-file').classList.add('active');
      document.getElementById('view-commits').style.display = 'none';
      document.getElementById('view-file').style.display = '';

      document.getElementById('file-content-area').innerHTML = '<div class="loading"><div class="spinner"></div><br>Loading…</div>';

      try {
        const qs = currentRef ? '&ref=' + encodeURIComponent(currentRef) : '';
        const res = await fetch(API + '/ui/blob?path=' + encodeURIComponent(filePath) + qs);
        if (!res.ok) throw new Error('File not found');
        const data = await res.json();
        
        let lang = 'javascript';
        if (filePath.endsWith('.md')) lang = 'markdown';
        else if (filePath.endsWith('.json')) lang = 'json';
        else if (filePath.endsWith('.css')) lang = 'css';
        else if (filePath.endsWith('.html')) lang = 'html';
        else if (filePath.endsWith('.sh')) lang = 'bash';

        document.getElementById('file-content-area').innerHTML = \`
          <div class="file-viewer">
            <div class="file-viewer-header">
              <span class="file-path">\${escHtml(filePath)}</span>
              <span class="file-size">\${data.size} bytes · \${data.lines} lines</span>
            </div>
            <pre><code id="file-code" class="language-\${lang}"></code></pre>
          </div>
        \`;
        
        const codeEl = document.getElementById('file-code');
        codeEl.textContent = data.content;
        if (window.Prism) Prism.highlightElement(codeEl);
      } catch (e) {
        document.getElementById('file-content-area').innerHTML = \`<div class="empty">Could not load file: \${e.message}</div>\`;
      }
    }

    function escHtml(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    loadInfo().catch(e => {
      document.getElementById('commit-graph').innerHTML = '<div class="empty">Error loading repository: ' + e.message + '</div>';
    });
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------
/**
 * Create and return an Express server for sharing the repository over LAN.
 * @param {string} logitDir
 * @param {string} repoRoot
 * @param {{ token?: string, readOnly?: boolean }} opts
 */
export function createServer(logitDir, repoRoot, opts = {}) {
  const { token = null, readOnly = false } = opts;
  const app = express();

  // Raw body for packfile uploads (must come before json middleware)
  app.use('/packfile', (req, res, next) => {
    if (req.method === 'POST') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => { req.rawBody = Buffer.concat(chunks); next(); });
    } else {
      next();
    }
  });

  app.use(express.json({ limit: '50mb' }));

  // Auth middleware on all routes
  app.use(makeAuthMiddleware(token, readOnly));

  // ── Web UI ──────────────────────────────────────────────────────────────
  app.get('/', (req, res) => {
    const repoName = path.basename(repoRoot);
    res.set('Content-Type', 'text/html');
    res.send(buildWebUI(repoName));
  });

  // ── Auth info (unauthenticated) ─────────────────────────────────────────
  app.get('/auth-info', (req, res) => {
    res.json({ requiresAuth: !!token, readOnly });
  });

  // ── Repository info ──────────────────────────────────────────────────────
  app.get('/info', async (req, res) => {
    try {
      const refs = await getAllRefs(logitDir);
      const head = await resolveHead(logitDir);
      res.json({ name: path.basename(repoRoot), head, refs });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Refs ─────────────────────────────────────────────────────────────────
  app.get('/refs', async (req, res) => {
    try {
      res.json(await getAllRefs(logitDir));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Objects list ──────────────────────────────────────────────────────────
  app.get('/objects/list', async (req, res) => {
    try {
      res.json(await listAllObjects(logitDir));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Single object ─────────────────────────────────────────────────────────
  app.get('/objects/:hash', async (req, res) => {
    try {
      const { hash } = req.params;
      if (!(await objectExists(logitDir, hash))) {
        return res.status(404).json({ error: `Object ${hash} not found` });
      }
      const objPath = path.join(logitDir, 'objects', hash.substring(0, 2), hash.substring(2));
      const data = await fs.readFile(objPath);
      res.set('Content-Type', 'application/octet-stream');
      res.send(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Legacy JSON push ──────────────────────────────────────────────────────
  app.post('/objects', async (req, res) => {
    try {
      const { objects } = req.body;
      if (!objects || !Array.isArray(objects)) {
        return res.status(400).json({ error: 'Expected { objects: [...] }' });
      }
      let stored = 0;
      for (const obj of objects) {
        if (!(await objectExists(logitDir, obj.hash))) {
          const data = Buffer.from(obj.data, 'base64');
          const objDir = path.join(logitDir, 'objects', obj.hash.substring(0, 2));
          const objPath = path.join(objDir, obj.hash.substring(2));
          await fs.mkdir(objDir, { recursive: true });
          await fs.writeFile(objPath, data);
          stored++;
        }
      }
      res.json({ stored, message: `Stored ${stored} new object(s).` });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Packfile GET (for pull/clone) ─────────────────────────────────────────
  app.get('/packfile', async (req, res) => {
    try {
      const hashParam = req.query.hashes;
      if (!hashParam) return res.status(400).json({ error: 'Missing hashes query param' });
      const hashes = hashParam.split(',').filter(Boolean);
      if (hashes.length === 0) return res.status(400).json({ error: 'No hashes provided' });

      const packBuffer = await createPackfile(logitDir, hashes);
      res.set('Content-Type', 'application/octet-stream');
      res.send(packBuffer);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Packfile POST (for push) ───────────────────────────────────────────────
  app.post('/packfile', async (req, res) => {
    try {
      if (!req.rawBody || req.rawBody.length === 0) {
        return res.status(400).json({ error: 'Empty packfile body' });
      }
      const stored = await unpackPackfile(logitDir, req.rawBody);
      res.json({ stored, message: `Stored ${stored} new object(s) from packfile.` });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Update refs ───────────────────────────────────────────────────────────
  app.post('/update-refs', async (req, res) => {
    try {
      const { refs } = req.body;
      if (!refs || typeof refs !== 'object') {
        return res.status(400).json({ error: 'Expected { refs: { ... } }' });
      }
      for (const [refName, hash] of Object.entries(refs)) {
        const refPath = path.join(logitDir, refName);
        await fs.mkdir(path.dirname(refPath), { recursive: true });
        await fs.writeFile(refPath, hash + '\n');
      }
      res.json({ message: 'Refs updated.' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── UI: commits ──────────────────────────────────────────────────────────
  app.get('/ui/commits', async (req, res) => {
    try {
      const ref = req.query.ref;
      let head;
      if (ref) {
        if (ref.startsWith('refs/')) {
          const refPath = path.join(logitDir, ref);
          try {
            head = (await fs.readFile(refPath, 'utf-8')).trim();
          } catch(e) {}
        } else {
          head = ref; // assume it's a hash
        }
      } else {
        head = await resolveHead(logitDir);
      }
      
      if (!head) return res.json([]);
      const commits = await getCommitLog(logitDir, head, 100);
      res.json(commits);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── UI: tags ──────────────────────────────────────────────────────────────
  app.get('/ui/tags', async (req, res) => {
    try {
      const tagsDir = path.join(logitDir, 'refs', 'tags');
      const result = {};
      try {
        const entries = await fs.readdir(tagsDir);
        for (const name of entries) {
          const hash = (await fs.readFile(path.join(tagsDir, name), 'utf-8')).trim();
          result[name] = hash;
        }
      } catch { /* no tags */ }
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── UI: file tree from HEAD ───────────────────────────────────────────────
  app.get('/ui/tree', async (req, res) => {
    try {
      const ref = req.query.ref;
      let commitHash;

      if (ref) {
        if (ref.startsWith('refs/')) {
          try {
            commitHash = (await fs.readFile(path.join(logitDir, ref), 'utf-8')).trim();
          } catch(e) {}
        } else {
          commitHash = ref;
        }
      } else {
        commitHash = await resolveHead(logitDir);
      }

      if (!commitHash) return res.json([]);

      const commit = await readCommit(logitDir, commitHash);
      const entries = await readTree(logitDir, commit.tree);
      res.json(entries.map((e) => e.name));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── UI: blob content ──────────────────────────────────────────────────────
  app.get('/ui/blob', async (req, res) => {
    try {
      const filePath = req.query.path;
      if (!filePath) return res.status(400).json({ error: 'Missing path param' });

      const ref = req.query.ref;
      let commitHash;
      if (ref) {
        if (ref.startsWith('refs/')) {
          try {
            commitHash = (await fs.readFile(path.join(logitDir, ref), 'utf-8')).trim();
          } catch(e) {}
        } else {
          commitHash = ref;
        }
      } else {
        commitHash = await resolveHead(logitDir);
      }

      if (!commitHash) return res.status(404).json({ error: 'No commits' });

      const commit = await readCommit(logitDir, commitHash);
      const entries = await readTree(logitDir, commit.tree);
      const entry = entries.find((e) => e.name === filePath);

      if (!entry) return res.status(404).json({ error: `File '${filePath}' not found in HEAD` });

      const obj = await readObject(logitDir, entry.hash);
      const content = obj.content.toString('utf-8');
      const lines = content.split('\n').length;

      res.json({
        path: filePath,
        hash: entry.hash,
        size: obj.content.length,
        lines,
        content
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── UI: commit diff ───────────────────────────────────────────────────────
  app.get('/ui/commit/:hash/diff', async (req, res) => {
    try {
      const { hash } = req.params;
      const commit = await readCommit(logitDir, hash);
      
      let parentTreeEntries = [];
      if (commit.parent) {
        const parentCommit = await readCommit(logitDir, commit.parent);
        parentTreeEntries = await readTree(logitDir, parentCommit.tree);
      }
      
      const currentTreeEntries = await readTree(logitDir, commit.tree);
      
      // Build maps
      const parentFiles = {};
      for (const e of parentTreeEntries) parentFiles[e.name] = e.hash;
      
      const currentFiles = {};
      for (const e of currentTreeEntries) currentFiles[e.name] = e.hash;
      
      const allFiles = [...new Set([...Object.keys(parentFiles), ...Object.keys(currentFiles)])];
      const diffs = [];
      
      for (const file of allFiles) {
        const oldHash = parentFiles[file];
        const newHash = currentFiles[file];
        
        if (oldHash === newHash) continue; // no change
        
        let oldContent = '';
        if (oldHash) {
          try {
            const obj = await readObject(logitDir, oldHash);
            oldContent = obj.content.toString('utf-8');
          } catch(e) {}
        }
        
        let newContent = '';
        if (newHash) {
          try {
            const obj = await readObject(logitDir, newHash);
            newContent = obj.content.toString('utf-8');
          } catch(e) {}
        }
        
        const patch = Diff.createPatch(file, oldContent, newContent, commit.parent ? commit.parent.substring(0,7) : 'empty', hash.substring(0,7));
        diffs.push({ file, patch });
      }
      
      res.json(diffs);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return app;
}
