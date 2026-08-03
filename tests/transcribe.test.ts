import { afterEach, describe, expect, it, vi } from 'vitest';
import { transcribeVoice } from '../src/transcribe';
import type { Env } from '../src/types';
import { stubFetch, jsonResponse } from './helpers';

afterEach(() => { vi.restoreAllMocks(); });

function envWith(aiResult: unknown): Env {
  return {
    TELEGRAM_BOT_TOKEN: 'tok',
    AI: { run: vi.fn(async () => aiResult) },
  } as unknown as Env;
}

describe('transcribeVoice', () => {
  it('returns the transcript text', async () => {
    stubFetch(async (url) => {
      if (String(url).includes('getFile')) {
        return jsonResponse({ ok: true, result: { file_path: 'voice/a.oga' } });
      }
      return new Response(new Uint8Array([1, 2, 3]));
    });

    const env = envWith({ text: 'euro dollar buy at 1.0850' });
    expect(await transcribeVoice(env, 'file1')).toBe('euro dollar buy at 1.0850');
  });

  it('returns null when the file cannot be located', async () => {
    stubFetch(async () => jsonResponse({ ok: false }));
    expect(await transcribeVoice(envWith({ text: 'x' }), 'file1')).toBe(null);
  });

  it('returns null when the model returns an empty transcript', async () => {
    stubFetch(async (url) => {
      if (String(url).includes('getFile')) {
        return jsonResponse({ ok: true, result: { file_path: 'voice/a.oga' } });
      }
      return new Response(new Uint8Array([1, 2, 3]));
    });
    expect(await transcribeVoice(envWith({ text: '   ' }), 'file1')).toBe(null);
  });

  it('returns null rather than throwing when the model errors', async () => {
    stubFetch(async (url) => {
      if (String(url).includes('getFile')) {
        return jsonResponse({ ok: true, result: { file_path: 'voice/a.oga' } });
      }
      return new Response(new Uint8Array([1, 2, 3]));
    });
    const env = {
      TELEGRAM_BOT_TOKEN: 'tok',
      AI: { run: vi.fn(async () => { throw new Error('model down'); }) },
    } as unknown as Env;
    expect(await transcribeVoice(env, 'file1')).toBe(null);
  });
});
