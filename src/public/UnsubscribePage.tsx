import { useState } from 'react';
import { api } from './api';
import { Shell, useConfig } from './components';

export function UnsubscribePage() {
  const { config } = useConfig();
  const t = new URLSearchParams(window.location.search).get('t') ?? '';
  const [state, setState] = useState<'ask' | 'done' | 'error'>('ask');

  async function go(channel: 'email' | 'mail') {
    try {
      await api.unsubscribe(t, channel);
      setState('done');
    } catch {
      setState('error');
    }
  }

  return (
    <Shell config={config}>
      {state === 'ask' && (
        <section>
          <h1>Stop service reminders?</h1>
          <p>You’ll still get emails about appointments you book.</p>
          <div className="stack">
            <button className="btn primary big" onClick={() => go('email')}>Stop reminder emails</button>
            <button className="btn big" onClick={() => go('mail')}>Stop reminder postcards</button>
          </div>
        </section>
      )}
      {state === 'done' && (
        <section>
          <h1>You’re unsubscribed</h1>
          <p>We won’t send you those reminders again.</p>
        </section>
      )}
      {state === 'error' && (
        <section>
          <h1>That link didn’t work</h1>
          <p>Call us{config?.shop_phone ? ` at ${config.shop_phone}` : ''} and we’ll take you off the list.</p>
        </section>
      )}
    </Shell>
  );
}
