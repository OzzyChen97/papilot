import { useId, useState } from 'react';
import { errorText, t } from './i18n.ts';

export interface CollaborationSettingsProps { enabled: boolean; online: boolean; save: (enabled: boolean) => Promise<void> }
export function CollaborationSettings({ enabled, online, save }: CollaborationSettingsProps) {
  const id = useId();
  const [saving, setSaving] = useState(false), [error, setError] = useState('');
  async function change(value: boolean) {
    setSaving(true); setError('');
    try { await save(value); } catch (error) { setError(errorText(error instanceof Error ? error.message : String(error))); }
    finally { setSaving(false); }
  }
  return <div className="settings-card">
    <div className="settings-row settings-toggle">
      <div className="settings-text">
        <label className="settings-name" htmlFor={id}>{t('Enable collaboration mode')}</label>
        <p id={id + '-detail'}>{t('Codex coordinates DeepSeek through OpenCode Go and Argon through Antigravity, then checks every annotation. Requires their host sign-ins. Off by default.')}</p>
      </div>
      <input id={id} type="checkbox" className="switch" role="switch" aria-describedby={id + '-detail'} checked={enabled} disabled={!online || saving} onChange={event => void change(event.target.checked)}/>
    </div>
    {error && <p role="alert" className="settings-card-body">{error}</p>}
  </div>;
}
