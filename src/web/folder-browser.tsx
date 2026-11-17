import { useEffect, useId, useRef, useState } from 'react';
import type { FolderListing } from '../shared.ts';
import { chooseDirectory, nativeFolders } from './desktop-chrome.tsx';
import { Icon } from './icons.tsx';
import { t } from './i18n.ts';
import './folder-browser.css';

type Api = <T = any>(route: string, body?: unknown, signal?: AbortSignal) => Promise<T>;

// The desktop app and a browser on the computer running Papilot use the system
// folder picker. `pick` resolves null when cancelled, or undefined when the page
// should browse instead: on another device, such as a phone connected through
// Tailscale, or when the person chooses to stop waiting for a picker they cannot see.
export function useFolderPicker(api: Api) {
  const [waiting, setWaiting] = useState(false), request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function pick(title: string, start: string): Promise<string | null | undefined> {
    if (nativeFolders) return chooseDirectory();
    const controller = new AbortController(); request.current = controller; setWaiting(true);
    try {
      const value = await api<{ path: string | null } | { unavailable: true }>('/folders/choose', { title, path: start }, controller.signal);
      return 'unavailable' in value ? undefined : value.path;
    } catch (failure) { if (controller.signal.aborted) return undefined; throw failure; }
    finally { if (request.current === controller) { request.current = null; setWaiting(false); } }
  }
  return { waiting, pick, browseInstead: () => request.current?.abort() };
}

// While the system picker is open, its button reads "Choosing…" and stays
// focusable so the change is announced. The picker may open behind other windows
// or on a screen nobody is watching, so browsing in the page stays one click away.
export function FolderChooser({ picker, label, icon = true, disabled, onChoose, ...props }: { picker: ReturnType<typeof useFolderPicker>; label: string; icon?: boolean; disabled: boolean; onChoose: () => void } & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'disabled'>) {
  return <span className="folder-chooser">
    <button type="button" {...props} className="button secondary compact" disabled={disabled && !picker.waiting} aria-disabled={picker.waiting || undefined} onClick={() => { if (!picker.waiting) onChoose(); }}>
      {picker.waiting ? <><span className="spinner"/>{t('Choosing…')}</> : <>{icon && <Icon name="folder" size={15}/>}{label}</>}
    </button>
    {picker.waiting && <button type="button" className="button ghost compact" onClick={picker.browseInstead}>{t('Browse here instead')}</button>}
  </span>;
}

// Lists folders on the computer running Papilot. Entering a folder or typing a
// path moves the browser; the action chooses the folder shown.
export function FolderBrowser({ api, start, action, onChoose, onCancel }: { api: Api; start: string; action: string; onChoose: (path: string) => void; onCancel: () => void }) {
  const [listing, setListing] = useState<FolderListing | null>(null), [draft, setDraft] = useState(start), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const field = useRef<HTMLInputElement>(null), request = useRef<AbortController | null>(null), id = useId();
  async function load(target: string) {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setLoading(true); setError('');
    try { const value = await api<FolderListing>('/folders', { path: target }, controller.signal); setListing(value); setDraft(value.path); }
    catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (request.current === controller) setLoading(false); }
  }
  // The button that opened the browser, or the folder just entered, is replaced; the path field keeps focus.
  const enter = (target: string) => { field.current?.focus(); void load(target); };
  useEffect(() => { field.current?.focus(); void load(start); return () => request.current?.abort(); }, []);
  return <div className="folder-browser" role="group" aria-labelledby={id + '-where'} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); } }}>
    <div className="folder-browser-head">
      <button type="button" className="icon-button" aria-label={t('Parent folder')} title={t('Parent folder')} disabled={!listing?.parent || loading} onClick={() => enter(listing!.parent!)}><Icon name="arrowUp" size={16}/></button>
      <input ref={field} aria-label={t('Folder path')} value={draft} maxLength={4000} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} enterKeyHint="go"
        onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void load(draft); } }}/>
    </div>
    <div className="folder-browser-body">
      {error ? <p className="inline-error" role="alert">{error}</p>
        : !listing ? <p className="folder-browser-note"><span className="spinner"/>{t('Loading folders…')}</p>
        : listing.folders.length ? <ul role="list" className="folder-browser-list" aria-label={listing.path} aria-busy={loading || undefined}>
          {listing.folders.map(folder => <li key={folder.path}><button type="button" disabled={loading} onClick={() => enter(folder.path)}><Icon name="folder" size={15}/><span>{folder.name}</span><Icon name="chevronRight" size={14}/></button></li>)}
        </ul>
        : <p className="folder-browser-note">{t('No folders inside.')}</p>}
    </div>
    <div className="folder-browser-actions">
      <span id={id + '-where'}>{t('Folders on the computer running Papilot')}</span>
      <div className="folder-browser-buttons">
        <button type="button" className="button ghost compact" onClick={onCancel}>{t('Cancel')}</button>
        <button type="button" className="button primary compact" disabled={!listing || loading || Boolean(error)} onClick={() => listing && onChoose(listing.path)}>{action}</button>
      </div>
    </div>
  </div>;
}
