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


## First-response deadline and cancellation (#37)

`CHAT_BUILD_TIMEOUT_MS` is the **one inbound chat request's build/first-response
budget**, including body parsing and routing, preprocessing, upstream response
headers, retries/backoff, Codex/Combo SSE peeks, and account/model fallback. The
positive millisecond setting defaults to **110000 (110 seconds)**; invalid or
non-positive values fall back to that default. The budget is not renewed by a
new account, model, URL, or retry.

Codex gets the remaining build budget for a single response-header wait by
default: a mocked upstream returning headers at 90 seconds is allowed to finish
without being restarted at 60 seconds. Other BaseExecutor providers retain
`FETCH_CONNECT_TIMEOUT_MS` (default 60000), capped by the remaining build budget.
The existing internal `transport.timeoutMs` hook can impose a provider-specific
header ceiling; the provider-overrides management API still accepts headers only.
This change does not add a timeout UI or infer a model/context-size threshold.

A local header timeout or exhausted build budget terminates with HTTP **504**,
without repeating an expensive request or penalizing the selected account. An
inbound client abort terminates work with an internal HTTP **499** result (a
closed client may not receive a response). Ordinary provider HTTP 502/503 retry
policies and 429/account/model fallback remain bounded by the same budget.
Cancellation is recognized from explicit local error codes/signals, not merely an
exception's name; arbitrary client abort reasons are not echoed into logs.

The build timer ends only when 9Router hands its final Response downstream,
after any peek. **A healthy stream may continue longer than 110 seconds.** Client
cancellation remains connected until body completion/cancel; existing stream
first-chunk and inter-chunk stall limits remain separate. Shared account-token or
project-ID refresh/cache operations may finish for other callers after this
request stops waiting; they cannot resume this request's model dispatch. An
already-started OAuth refresh is allowed to persist its rotated token even after
cancellation, so the next request does not lose valid credentials. Abandoned
Fusion panels use child cancellation scopes; finishing the judge stream never
unbounds an ignored panel.

110 seconds is a conservative default with nominal margin below the reported
120-second external failure; it is **not proof** of deployed client/nginx
header, idle, or total-request settings. Operators must verify the smallest
relevant limit in their actual chain. To permit a 180-second first response,
raise the explicit build budget and all applicable external limits together.
No nginx, network, deployment, release, or credential setting is changed here.
`nginx upstream_status=-` describes nginx→9Router and alone cannot distinguish
provider header wait from a post-header peek.

Production-level phase logs identify a generated, non-PII request ID, each fetch
attempt, attempt/total elapsed time, remaining budget, proxy mode, headers received, peek release and downstream handoff without
including authorization, request bodies, raw proxy URLs or client abort reasons.
The PR workflow runs focused fake-timer/mock regressions with outbound networking
blocked in the test process, plus the normal production build. It does not run
real-provider tests and is not a claim that the historically failing full suite
is green.
