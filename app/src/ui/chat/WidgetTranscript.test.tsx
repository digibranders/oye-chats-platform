import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_APPEARANCE,
  WidgetTranscript,
  appearanceFromBot,
  type WidgetAppearance,
  type WidgetMessage,
} from './WidgetTranscript';

vi.mock('./PremiumOrb', () => ({ default: () => <span data-orb /> }));

/**
 * The one renderer two surfaces share, and the things they used to disagree on.
 *
 * The Experience page previews a widget the customer is styling; the Leads
 * drawer replays a conversation that already happened. Both are pictures of the
 * same product, and each had its own implementation: the preview drew the
 * visitor's bubble at a 16px radius against the widget's 8, and the drawer drew
 * every speaker in a console grey under an uppercase mono label — 23 of them
 * down one column, which is what made that panel unreadable.
 *
 * What is pinned here is the widget's anatomy, because that is the contract
 * both callers are relying on.
 */

const APPEARANCE: WidgetAppearance = {
  primaryColor: '#2563EB',
  userBubbleColor: '#DBE9FF',
  avatarType: 'mascot',
  botLogo: null,
  orbColor: null,
};

function message(over: Partial<WidgetMessage> & Pick<WidgetMessage, 'key' | 'role'>): WidgetMessage {
  return { text: 'Hello there', ...over };
}

const time = (at: string) => at.slice(11, 16);

function transcript(messages: WidgetMessage[], props: Record<string, unknown> = {}) {
  return render(
    <WidgetTranscript appearance={APPEARANCE} messages={messages} timeLabel={time} {...props} />,
  );
}

describe('WidgetTranscript', () => {
  it('gives the visitor a bubble in the chatbot colour and nobody else one', () => {
    transcript([
      message({ key: 'a', role: 'visitor', text: 'what is the pricing?' }),
      message({ key: 'b', role: 'bot', text: 'Ask the team.' }),
      message({ key: 'c', role: 'operator', text: 'hi there' }),
    ]);

    const bubbles = document.querySelectorAll('[data-widget-bubble]');
    expect(bubbles).toHaveLength(1);
    expect((bubbles[0] as HTMLElement).style.backgroundColor).toBe('rgb(219, 233, 255)');
    // 8, not the window's 16. `themeConfigs` gives the visitor bubble
    // `rounded-lg`, and the preview had been drawing it at the window radius.
    expect((bubbles[0] as HTMLElement).style.borderRadius).toBe('8px');
  });

  it('renders the AI as markdown and a person verbatim', () => {
    // The AI writes markdown, so an operator reading its answer would otherwise
    // see the asterisks the visitor never saw. A person's own asterisks are
    // theirs, and reformatting them is rewriting what they typed.
    transcript([
      message({ key: 'a', role: 'bot', text: 'Our **SOC** watches everything.' }),
      message({ key: 'b', role: 'visitor', text: 'is it **really** everything?' }),
    ]);

    expect(screen.getByText('SOC').tagName).toBe('STRONG');
    expect(screen.getByText('is it **really** everything?')).toBeInTheDocument();
  });

  it('names the operator in the chatbot colour, once per run', () => {
    transcript(
      [
        message({ key: 'a', role: 'operator', text: 'hi there' }),
        message({ key: 'b', role: 'operator', text: 'what is your timeline?' }),
      ],
      { operatorName: 'Siddique Ahmed' },
    );

    const names = screen.getAllByText('Siddique Ahmed');
    expect(names).toHaveLength(1);
    expect(names[0].style.color).toBe('rgb(37, 99, 235)');
  });

  it('falls back to a label when nobody knows who the operator was', () => {
    transcript([message({ key: 'a', role: 'operator' })], { operatorFallback: 'Operator' });
    expect(screen.getByText('Operator')).toBeInTheDocument();
  });

  it('dates the end of a run, not every message in it', () => {
    // "hello / are you there? / hello" is one thought in three bubbles. The
    // panel this replaces printed a clock and a speaker label on all three.
    transcript(
      [
        message({ key: 'a', role: 'visitor', text: 'hello', at: '2026-09-08T10:59:00Z' }),
        message({ key: 'b', role: 'visitor', text: 'are you there ?', at: '2026-09-08T10:59:20Z' }),
        message({ key: 'c', role: 'visitor', text: 'hello', at: '2026-09-08T10:59:40Z' }),
        message({ key: 'd', role: 'bot', text: 'Still here.', at: '2026-09-08T11:00:00Z' }),
      ],
      { showTimes: true },
    );

    const times = document.querySelectorAll('[data-widget-time]');
    expect(times).toHaveLength(2);
    expect(times[0].textContent).toBe('10:59');
    expect(times[1].textContent).toBe('11:00');
  });

  it('shows no clocks at all when the caller does not ask for them', () => {
    // The widget itself has none: a visitor watching a reply arrive does not
    // need to be told when it arrived. Only the record turns them on.
    transcript([message({ key: 'a', role: 'visitor', at: '2026-09-08T10:59:00Z' })]);
    expect(document.querySelectorAll('[data-widget-time]')).toHaveLength(0);
  });

  it('closes the gap within a run and opens it when the speaker changes', () => {
    transcript([
      message({ key: 'a', role: 'visitor', text: 'hello' }),
      message({ key: 'b', role: 'visitor', text: 'are you there ?' }),
      message({ key: 'c', role: 'bot', text: 'Still here.' }),
    ]);

    const rows = document.querySelectorAll('[data-widget-role]');
    expect((rows[0] as HTMLElement).style.marginTop).toBe('');
    expect((rows[1] as HTMLElement).style.marginTop).toBe('10px');
    expect((rows[2] as HTMLElement).style.marginTop).toBe('20px');
  });

  it('breaks a run at a system line', () => {
    // What happened to the conversation is a boundary in it. Without this the
    // operator's first message after "Operator joined" would be tucked up
    // against the event as though it continued a run.
    transcript([
      message({ key: 'a', role: 'operator', text: 'hi' }),
      message({ key: 'b', role: 'system', text: 'Transferred' }),
      message({ key: 'c', role: 'operator', text: 'still hi' }),
    ]);

    expect(screen.getAllByText(/^hi$|^still hi$/)).toHaveLength(2);
    // The name is redrawn after the break, because it is a new run.
    expect(screen.getAllByText('Operator')).toHaveLength(2);
  });

  it('renders an event as a quiet centred line, not as a speaker', () => {
    transcript([message({ key: 'a', role: 'system', text: 'Operator joined' })]);
    const line = document.querySelector('[data-widget-role="system"]') as HTMLElement;
    expect(line.textContent).toBe('Operator joined');
    expect(line.style.textAlign).toBe('center');
    expect(document.querySelectorAll('[data-widget-bubble]')).toHaveLength(0);
  });

  it('marks each new day once', () => {
    transcript(
      [
        message({ key: 'a', role: 'visitor', at: '2026-09-07T10:00:00Z' }),
        message({ key: 'b', role: 'bot', at: '2026-09-07T10:01:00Z' }),
        message({ key: 'c', role: 'visitor', at: '2026-09-08T09:00:00Z' }),
      ],
      { dayLabel: (at: string | null | undefined) => (at ? at.slice(0, 10) : null) },
    );

    const days = [...document.querySelectorAll('[data-widget-day]')].map((d) => d.textContent);
    expect(days).toEqual(['2026-09-07', '2026-09-08']);
  });

  it('shows an image inline and a file as a link', () => {
    transcript([
      message({
        key: 'a',
        role: 'visitor',
        text: '',
        file: { url: 'https://cdn.test/shot.png', filename: 'shot.png', contentType: 'image/png' },
      }),
      message({
        key: 'b',
        role: 'visitor',
        text: '',
        file: { url: 'https://cdn.test/brief.pdf', filename: 'brief.pdf', contentType: 'application/pdf' },
      }),
    ]);

    expect(screen.getByRole('img', { name: 'shot.png' })).toHaveAttribute('src', 'https://cdn.test/shot.png');
    const link = screen.getByRole('link', { name: 'brief.pdf' });
    expect(link).toHaveAttribute('href', 'https://cdn.test/brief.pdf');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('draws the avatar once per run, holding the indent for the rest', () => {
    transcript([
      message({ key: 'a', role: 'bot', text: 'One.' }),
      message({ key: 'b', role: 'bot', text: 'Two.' }),
    ]);

    const marks = document.querySelectorAll('[data-widget-avatar="mascot"]');
    expect(marks).toHaveLength(2);
    // The second is present but invisible: removing it would unindent the
    // continuation and break the run's left edge.
    const holders = [...document.querySelectorAll('[data-widget-role="bot"] > span')] as HTMLElement[];
    expect(holders[0].style.visibility).toBe('visible');
    expect(holders[1].style.visibility).toBe('hidden');
  });
});

describe('appearanceFromBot', () => {
  it('reads a chatbot as the widget reads it', () => {
    expect(
      appearanceFromBot({
        primary_color: '#2563EB',
        user_bubble_color: '#DBE9FF',
        avatar_type: 'orb',
        bot_logo: null,
        orb_color: '#2B66BC',
      }),
    ).toEqual({
      primaryColor: '#2563EB',
      userBubbleColor: '#DBE9FF',
      avatarType: 'orb',
      botLogo: null,
      orbColor: '#2B66BC',
    });
  });

  it('falls back to the widget defaults when the chatbot is gone', () => {
    // A lead outlives the chatbot that captured it, so `null` is a real input:
    // the conversation still happened and still has to render.
    expect(appearanceFromBot(null)).toEqual(DEFAULT_APPEARANCE);
    expect(appearanceFromBot({}).primaryColor).toBe(DEFAULT_APPEARANCE.primaryColor);
  });

  it('ignores an avatar style it does not recognise', () => {
    expect(appearanceFromBot({ avatar_type: 'hologram' }).avatarType).toBeNull();
  });
});
