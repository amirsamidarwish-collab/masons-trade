import type { Env } from './types';
import { getFileUrl } from './telegram/api';

const MODEL = '@cf/openai/whisper' as const;

/**
 * Telegram voice note to text. Returns null on any failure - the caller tells
 * the operator to record again rather than proceeding on a partial transcript.
 */
export async function transcribeVoice(env: Env, fileId: string): Promise<string | null> {
  const url = await getFileUrl(env, fileId);
  if (!url) return null;

  try {
    const audioRes = await fetch(url);
    if (!audioRes.ok) return null;
    const bytes = new Uint8Array(await audioRes.arrayBuffer());

    const result = await env.AI.run(MODEL, { audio: [...bytes] });
    const text = (result?.text ?? '').trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}
