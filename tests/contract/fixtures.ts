export const timestamp = '2026-10-20T12:00:00.000Z';
export function claude(id = 'msg-1', input = 11, output = 20) {
  return {type: 'assistant', sessionId: 'claude-session', cwd: '/synthetic/private-project', timestamp,
    requestId: `req-${id}`, message: {id, model: 'claude-sonnet-4-6', content: [{type: 'text', text: 'PRIVATE_PROMPT_MARKER'}], usage: {
      input_tokens: input, output_tokens: output, cache_read_input_tokens: 100, cache_creation_input_tokens: 30,
      cache_creation: {ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20}, output_tokens_details: {reasoning_tokens: Math.min(7, output)},
    }}};
}
export const meta = {type: 'session_meta', payload: {id: 'codex-session', cwd: '/synthetic/codex-project', instructions: 'PRIVATE_PROMPT_MARKER'}};
export const context = {type: 'turn_context', payload: {turn_id: 'turn-1', cwd: '/synthetic/codex-project', model: 'gpt-5-codex'}};
export function usage(input: number, cached = 0, output = 0, reasoning = 0) {
  return {input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output};
}
export function codex(total: ReturnType<typeof usage> | null, last: ReturnType<typeof usage> | null = null, second = 0) {
  return {timestamp: `2026-10-20T12:00:${String(second).padStart(2, '0')}.000Z`, type: 'event_msg', payload: {type: 'token_count', info: {total_token_usage: total, last_token_usage: last}}};
}
export const jsonl = (...records: unknown[]) => records.map(record => JSON.stringify(record)).join('\n') + '\n';
