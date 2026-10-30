# Codex Responses transports

Codex OAuth models use the ChatGPT Codex backend. For GPT-6.1 Sol, select a transport through the model ID:

| Gateway model | Upstream model | Transport | Parallel tool calls |
|---|---|---|---|
| `cx/gpt-6.1-sol` | `gpt-6.1-sol` | Codex Responses Lite | Forced off, matching the Codex Lite protocol |
| `cx/gpt-6.1-sol-parallel` | `gpt-6.1-sol` | Ordinary Responses | Preserves the caller's explicit `true` or `false`; omission leaves the upstream default |

The alias uses the same Codex OAuth connections, model limits, supported reasoning levels and pricing as the original model. It selects a request protocol, not a different model or reasoning tier. Thinking suffixes such as `cx/gpt-6.1-sol-parallel(high)` also work.

For OpenCode or another Responses client, change the configured model to the parallel alias and send ordinary Responses input and tools:

```json
{
  "model": "cx/gpt-6.1-sol-parallel",
  "input": "Get the time in Tokyo and London using the tools.",
  "tools": [{
    "type": "function",
    "name": "get_time",
    "parameters": {
      "type": "object",
      "properties": { "city": { "type": "string" } },
      "required": ["city"],
      "additionalProperties": false
    }
  }],
  "parallel_tool_calls": true,
  "reasoning": { "effort": "high" },
  "stream": true
}
```

Send this body to `/v1/responses` with your gateway API key. Chat Completions clients may also select the alias; their explicit `parallel_tool_calls` setting survives translation to Responses.

`parallel_tool_calls: true` permits multiple calls but does not require a fixed count. Replay every returned function call and its matching `function_call_output` on the next turn, together with any reasoning/encrypted-content items needed for `store: false` continuity.

The original model ID retains Lite compatibility: tools move into an `additional_tools` input prefix, reasoning uses `context: "all_turns"`, and the internal Lite header is sent. The parallel alias switches the entire request to ordinary Responses, including headers, tool locations and reasoning configuration. Native Lite tool prefixes are promoted to top-level tools when selecting the alias. Hosted `web_search` also selects ordinary Responses, as before.

See [issue #36](https://github.com/codeasier/9router/issues/36) for the history and verification context. Offline regression tests check request/response preservation; real-model smoke tests separately check account compatibility and multi-turn tool execution.
