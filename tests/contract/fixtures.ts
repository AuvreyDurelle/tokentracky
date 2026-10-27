export const timestamp = '2026-10-20T12:00:00.000Z';
export function claude(id = 'msg-1', input = 11, output = 20) {
  return {type: 'assistant', sessionId: 'claude-session', cwd: '/synthetic/private-project', timestamp,
    requestId: `req-${id}`, message: {id, model: 'claude-sonnet-4-6', content: [{type: 'text', text: 'PRIVATE_PROMPT_MARKER'}], usage: {
      input_tokens: input, output_tokens: output, cache_read_input_tokens: 100, cache_creation_input_tokens: 30,
      cache_creation: {ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20}, output_tokens_details: {reasoning_tokens: Math.min(7, output)},
    }}};
}
export const jsonl = (...records: unknown[]) => records.map(record => JSON.stringify(record)).join('\n') + '\n';
