import React, { useEffect, useState, useCallback } from 'react';
import { host } from '../services/HostClient';

// Browsers without the File System Access API (Firefox) have no native save
// dialog, so Save/Save As route through this host-agent-backed picker
// instead of falling back to a download. mode: 'save' | 'open'.
function dirname(p) {
  const sep = p.includes('\\') && !p.includes('/') ? '\\' : '/';
  const idx = p.lastIndexOf(sep);
  if (idx <= 0) return sep;
  return p.slice(0, idx);
}

function joinPath(dir, name) {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
}

// Remembers the last folder browsed to across opens of this dialog (and
// across reloads), so re-opening Save As doesn't always start back at $HOME.
const LAST_DIR_KEY = 'kronEditor.savePathModal.lastDir';
const getLastDir = () => { try { return localStorage.getItem(LAST_DIR_KEY) || null; } catch { return null; } };
const setLastDir = (dir) => { try { localStorage.setItem(LAST_DIR_KEY, dir); } catch { /* ignore */ } };

export default function SavePathModal({ isOpen, mode = 'save', suggestedName = 'project.xml', initialPath, onConfirm, onCancel }) {
  const [currentDir, setCurrentDir] = useState(null);
  const [entries, setEntries] = useState([]);
  const [filename, setFilename] = useState(suggestedName);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const loadDir = useCallback(async (dir) => {
    setLoading(true);
    setError(null);
    try {
      const list = await host.listDir(dir);
      const filtered = mode === 'open'
        ? list.filter((e) => e.isDir || /\.xml$/i.test(e.name))
        : list;
      filtered.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
      setEntries(filtered);
      setCurrentDir(dir);
      setLastDir(dir);
    } catch (err) {
      setError(err.message || String(err));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [mode]);

  useEffect(() => {
    if (!isOpen) return;
    setFilename(mode === 'save' ? (suggestedName || 'project.xml') : '');
    setError(null);
    (async () => {
      const startDir = initialPath ? dirname(initialPath) : (getLastDir() || await host.homeDir().catch(() => '/'));
      loadDir(startDir);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  if (!isOpen) return null;

  const handleEntryClick = (entry) => {
    if (entry.isDir) {
      loadDir(joinPath(currentDir, entry.name));
    } else {
      setFilename(entry.name);
    }
  };

  const handleEntryDoubleClick = (entry) => {
    if (entry.isDir) return;
    if (mode === 'open') {
      onConfirm(joinPath(currentDir, entry.name));
    }
  };

  const handleUp = () => {
    if (!currentDir) return;
    const parent = dirname(currentDir);
    if (parent !== currentDir) loadDir(parent);
  };

  const handleConfirm = () => {
    if (!filename.trim()) {
      setError(mode === 'save' ? 'Enter a file name.' : 'Select a file.');
      return;
    }
    onConfirm(joinPath(currentDir, filename.trim()));
  };

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      background: 'rgba(0, 0, 0, 0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 99999
    }}>
      <div style={{
        background: '#252526', padding: '20px', borderRadius: '8px',
        width: '480px', border: '1px solid #444',
        boxShadow: '0 4px 6px rgba(0,0,0,0.3)', color: '#fff'
      }}>
        <h3 style={{ margin: '0 0 16px 0', borderBottom: '1px solid #444', paddingBottom: '10px' }}>
          {mode === 'save' ? 'Save As' : 'Open Project'}
        </h3>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
          <button onClick={handleUp} disabled={loading} style={{ padding: '4px 10px', background: 'transparent', border: '1px solid #666', color: '#fff', borderRadius: '4px', cursor: 'pointer' }}>↑ Up</button>
          <div style={{ flex: 1, fontSize: '12px', color: '#aaa', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {currentDir || '...'}
          </div>
        </div>

        <div style={{
          height: '220px', overflowY: 'auto', border: '1px solid #444',
          borderRadius: '4px', marginBottom: '12px', background: '#1e1e1e'
        }}>
          {loading && <div style={{ padding: '10px', color: '#aaa' }}>Loading…</div>}
          {!loading && entries.length === 0 && <div style={{ padding: '10px', color: '#777' }}>Empty folder</div>}
          {!loading && entries.map((entry) => (
            <div
              key={entry.name}
              onClick={() => handleEntryClick(entry)}
              onDoubleClick={() => handleEntryDoubleClick(entry)}
              style={{
                padding: '6px 10px', cursor: 'pointer',
                background: filename === entry.name && !entry.isDir ? '#0d47a1' : 'transparent',
              }}
            >
              {entry.isDir ? '📁' : '📄'} {entry.name}
            </div>
          ))}
        </div>

        <div style={{ marginBottom: '12px' }}>
          <input
            type="text"
            value={filename}
            onChange={(e) => setFilename(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleConfirm(); }}
            readOnly={mode === 'open'}
            placeholder="File name"
            style={{
              width: '100%', boxSizing: 'border-box', padding: '8px',
              background: '#1e1e1e', border: '1px solid #444', color: '#fff', borderRadius: '4px'
            }}
          />
        </div>

        {error && <div style={{ color: '#ff6b6b', marginBottom: '10px', fontSize: '13px' }}>{error}</div>}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
          <button onClick={onCancel} style={{ padding: '8px 16px', background: 'transparent', border: '1px solid #666', color: '#fff', borderRadius: '4px', cursor: 'pointer' }}>Cancel</button>
          <button onClick={handleConfirm} style={{ padding: '8px 16px', background: '#0d47a1', border: 'none', color: '#fff', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}>
            {mode === 'save' ? 'Save' : 'Open'}
          </button>
        </div>
      </div>
    </div>
  );
}
