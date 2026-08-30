# Acceptance Checklist

## Provider and Discovery

- [x] Registry contains exactly one built-in provider with ID and alias `step-plan`.
- [x] Registry sets `priority: 80` and the exact display metadata defined in `spec.md`.
- [x] Registry sets `category: "apikey"`, `authType: "apikey"`, and `authModes: ["apikey"]`.
- [x] Provider display name is `StepFun Step Plan` and its API-key acquisition link is `https://platform.stepfun.com/interface-key`.
- [x] Provider is media-only with `serviceKinds: ["image"]` and no chat transport requirement.
- [x] Top-level `imageConfig` declares Bearer API-key authentication plus the exact generation and validation endpoints.
- [x] `step-image-edit-2` is registered with `kind: "image"` and no edit capability.
- [x] `step-plan/step-image-edit-2` resolves through normal model parsing.
- [x] Provider appears in the dashboard Text to Image list and image-model discovery.
- [x] Static registry index appends Step Plan with the next contiguous identifier and matching export without moving or renumbering existing entries.

## Connection Management

- [x] `step-plan` is eligible for the existing generic API-key connection creation path.
- [x] A Step Plan connection is stored without a database migration or provider-specific credential form.
- [x] Multiple Step Plan connections can be selected by the existing image-handler credential loop.
- [x] `x-connection-id` selects the requested Step Plan connection when it is active and eligible.

## Runtime Request

- [x] Generation URL is exactly `https://api.stepfun.com/step_plan/v1/images/generations`.
- [x] Request uses JSON and `Authorization: Bearer <key>`.
- [x] Adapter accepts the key from either `credentials.apiKey` or `credentials.accessToken`.
- [x] Omitted `n` becomes 1 and any supplied `n` other than integer 1 is rejected locally.
- [x] Numeric `n: 1` is accepted; string `n: "1"`, fractional, zero, and other numeric values are rejected.
- [x] Omitted or `auto` size is not sent upstream.
- [x] Each of the five documented size strings is forwarded unchanged.
- [x] Any other size is rejected locally without reversing dimensions.
- [x] `response_format` accepts only `url` and `b64_json` when supplied.
- [x] `seed` accepts integers from 0 through 2147483647, including zero.
- [x] `steps` accepts integers from 1 through 50.
- [x] `cfg_scale` accepts numbers from 1.0 through 10.0, including decimals.
- [x] `negative_prompt` accepts at most 512 Unicode code points.
- [x] `text_mode` accepts only booleans and preserves explicit false.
- [x] Prompt is required and limited to 512 Unicode code points.
- [x] Explicit empty `negative_prompt` is preserved.
- [x] Unsupported fields are never forwarded to Step Plan.
- [x] Invalid requests return HTTP 400 and make no upstream fetch.

## Runtime Response and Errors

- [x] URL responses preserve `id`, `created`, `url`, `finish_reason`, and `seed`.
- [x] Base64 responses preserve `id`, `created`, `b64_json`, `finish_reason`, and `seed`.
- [x] Existing binary response mode works with Step Plan's first result.
- [x] Upstream 401/403, 429, and 5xx responses use existing image error formatting.
- [x] Network failures and invalid-JSON 2xx responses use the existing image-core error behavior.
- [x] A valid JSON body lacking OpenAI image fields is not newly rejected by this scoped change.
- [x] Existing preferred-connection, multi-account fallback, and combo paths can use Step Plan connections.
- [x] Local 9Router API-key enforcement remains active for Step Plan image requests.
- [x] No Step Plan-specific executor or translator is introduced.

## Credential Validation

- [x] Validation URL is exactly `https://api.stepfun.com/step_plan/v1/models`.
- [x] Validation uses GET, Bearer authentication, and no request body.
- [x] A configured `validateUrl` is the only probe target; failures never fall back to `imageConfig.baseUrl`.
- [x] Validation initiated by the connection-creation UI, and explicit validation, never call `/images/generations`; the persistence API itself makes no upstream request.
- [x] Successful model-list response accepts the credential.
- [x] 401 and 403 reject the credential.
- [x] Other non-2xx responses, timeout, and network failures are never reported as valid credentials.
- [x] Strict 2xx acceptance applies only when `validateUrl` is configured.
- [x] A tested media provider without validation metadata retains legacy acceptance for statuses other than 401/403.

## Dashboard

- [x] Step Plan model form exposes only `n`, `size`, `response_format`, `seed`, `steps`, `cfg_scale`, `negative_prompt`, and `text_mode` in addition to model and prompt.
- [x] Default form uses `n: 1`, `size: "1024x1024"`, `steps: 8`, and `cfg_scale: 1.0`.
- [x] Default form uses `response_format: "url"`, omits empty `seed` and `negative_prompt`, and submits `text_mode: false`.
- [x] Size control offers exactly the five documented Step Plan sizes.
- [x] Count control is a disabled fixed value and always submits 1.
- [x] Guidance control supports decimal values and documented range limits.
- [x] Invalid numeric values block Run with a local form error instead of relying only on HTML min/max attributes.
- [x] Text mode uses a boolean control rather than a text value.
- [x] Hidden global image defaults are absent from the Step Plan request.
- [x] Switching models removes or resets stale values that are invalid for the newly selected model.
- [x] Model `params` order controls rendered and submitted field order; `paramConfig` overrides matching global field definitions.
- [x] Model `options` arrays replace global arrays as whole values and are not concatenated.
- [x] Fields missing from model `params` are neither rendered nor submitted despite global defaults.
- [x] Boolean `text_mode` and disabled fixed `n` controls have dedicated dashboard tests.
- [x] `black-forest-labs/flux-pro-1.1` continues to render and submit `n`/`size` and no longer submits undeclared `quality`, `background`, `image_detail`, or `output_format`.
- [x] Dashboard does not advertise image-edit input or mask controls for Step Plan.

## Verification

- [x] Targeted Step Plan adapter tests pass.
- [x] Existing `tests/unit/image-generation.test.js` passes with no new failures.
- [x] Image-handler tests for local API key, preferred connection, multi-account fallback, combo, response pass-through, and binary-flag propagation pass.
- [x] Image-core tests for URL/base64-to-binary conversion pass.
- [x] Generic provider-creation eligibility tests pass.
- [x] Provider-validation route tests pass.
- [x] Dashboard parameter/request-construction tests pass.
- [x] Registry-to-adapter consistency test passes.
- [x] `node tests/__baseline__/verify-alias.mjs` passes after intentional snapshot update.
- [ ] `node tests/__baseline__/verify-providers.mjs` passes, or any intentional provider diff is reviewed and snapshotted according to repository policy.
- [ ] Applicable provider/model baseline verifiers pass.
- [x] ESLint reports no new errors in changed files.
- [x] No production or test files outside the closed scope listed in `spec.md` are changed without an approved spec amendment.
- [x] No live generation test is required without an explicitly supplied Step Plan credential.
