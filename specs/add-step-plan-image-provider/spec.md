# Add Step Plan Image Provider

## Motivation

9Router already exposes an OpenAI-compatible `POST /v1/images/generations` endpoint, but Step Plan is not available as a built-in provider. Users with a Step Plan subscription currently cannot select a Step Plan connection, address the `step-image-edit-2` model through the normal `provider/model` syntax, or configure its generation-specific parameters in the dashboard.

Step Plan must be represented separately from any future standard StepFun provider because it uses a dedicated API key, base URL, subscription quota, and billing system.

## Goal

Add `step-plan` as a built-in, API-key image provider with complete text-to-image support for `step-image-edit-2`, including runtime parameter validation, URL and base64 responses, provider discovery, safe credential validation, dashboard parameter controls, and regression coverage.

## Source Contract

The implementation is based on the StepFun documentation available when this specification was written:

- Step Plan image endpoint: `POST https://api.stepfun.com/step_plan/v1/images/generations`
- Credential validation endpoint: `GET https://api.stepfun.com/step_plan/v1/models`
- Authentication: `Authorization: Bearer <STEP_PLAN_API_KEY>`
- API-key acquisition URL: `https://platform.stepfun.com/interface-key`
- Model: `step-image-edit-2`
- Response shape: OpenAI-like JSON containing `created` and `data`; each result may contain `url` or `b64_json`, plus `finish_reason` and `seed`
- Prompt limit: 512 Unicode characters
- Number of images: exactly 1
- Sizes, expressed using StepFun's documented height-by-width convention:
  - `1024x1024`
  - `768x1360`
  - `896x1184`
  - `1360x768`
  - `1184x896`
- `response_format`: `url` or `b64_json`; upstream default is `url`
- `seed`: integer from 0 through 2147483647
- `steps`: integer from 1 through 50; default 8
- `cfg_scale`: number from 1.0 through 10.0; default 1.0
- `negative_prompt`: at most 512 Unicode characters; default empty
- `text_mode`: boolean; default false

References:

- https://platform.stepfun.com/docs/zh/step-plan/integrations/image-api
- https://platform.stepfun.com/docs/zh/api-reference/images/image
- https://platform.stepfun.com/docs/zh/guides/models/step-image-edit-2
- https://platform.stepfun.com/docs/zh/step-plan/overview

## Scope

### In Scope

- A distinct built-in provider with ID and alias `step-plan` and display name `StepFun Step Plan`.
- API-key connections stored through the existing connection persistence model.
- One image model, `step-image-edit-2`, addressed as `step-plan/step-image-edit-2`.
- Text-to-image requests through the existing local `POST /v1/images/generations` endpoint.
- A dedicated Step Plan image adapter that maps and validates Step Plan fields.
- Existing preferred-connection, multi-account fallback, combo fallback, local API-key protection, JSON output, and binary-output behavior.
- Dashboard provider discovery, connection creation, model selection, and Step Plan-specific generation controls.
- Safe API-key validation that does not submit a generation request.
- Unit and regression tests for runtime, registry, validation, and dashboard request construction.

### Out of Scope

- Standard pay-as-you-go StepFun API support at `https://api.stepfun.com/v1`.
- Image editing through `POST /step_plan/v1/images/edits`.
- A new local `/v1/images/edits` route or multipart upload pipeline.
- Advertising `step-image-edit-2` with an `edit` capability in the dashboard.
- Usage or Credit balance retrieval.
- Cost accounting changes in the image core.
- Changes to global account/combo fallback policy, binary URL-fetch hardening, or image-core timeout architecture unless required to preserve existing behavior.
- OAuth support.

## Design

### Provider Identity and Registry

Add a media-only registry entry for `step-plan`:

- `id` and `alias` are both `step-plan`.
- `priority` is 80.
- `category` and `authType` are `apikey`; `authModes` contains only `apikey`.
- `serviceKinds` contains only `image`.
- `display` is `{ name: "StepFun Step Plan", icon: "image", color: "#FF6A00", textIcon: "SP", website: "https://platform.stepfun.com", notice: { apiKeyUrl: "https://platform.stepfun.com/interface-key" } }`.
- `imageConfig.baseUrl` is the Step Plan generation endpoint.
- `imageConfig.authType` is `apikey` and `imageConfig.authHeader` is `bearer`.
- `imageConfig.validateUrl` is `https://api.stepfun.com/step_plan/v1/models` and `imageConfig.validateMethod` is `GET`.
- `models` contains only `step-image-edit-2` with `kind: "image"`.
- The model declares only supported request parameters and contains dashboard parameter metadata for defaults, types, ranges, and allowed values.

`serviceKinds` and `imageConfig` are top-level registry fields, matching current image-provider entries. The nested `media` example in `REGISTRY_TEMPLATE.js` is stale and must not be followed.

The registry entry must be included in the generated static registry index. This checkout does not contain a working generator for that index, so implementation must update `open-sse/providers/registry/index.js` directly: retain every existing import and export in its current relative order, append `step-plan.js` using the next contiguous import identifier, and append that identifier to the export array. No existing import may be moved or renumbered. No chat `transport` is required because this change exposes Step Plan only as an image provider.

### Runtime Adapter

Use a dedicated adapter rather than `createOpenAIAdapter`. The existing generic adapter does not include Step Plan-specific fields and cannot enforce its size and count constraints.

The adapter must:

- Build the fixed Step Plan generation URL from registry media configuration.
- Send `Content-Type: application/json` and a Bearer API key obtained from `credentials.apiKey` or `credentials.accessToken`.
- Always send `model` and `prompt`.
- Default an omitted `n` to 1 and reject any supplied value other than integer 1.
- Omit `size` when absent or equal to `auto`; otherwise require one of the documented Step Plan size strings and forward it unchanged.
- Forward `response_format`, `seed`, `steps`, `cfg_scale`, `negative_prompt`, and `text_mode` only when supplied.
- Preserve valid falsey values such as `seed: 0`, `negative_prompt: ""`, and `text_mode: false` when explicitly supplied.
- Reject invalid types, ranges, enum values, and prompts longer than 512 Unicode code points before making an upstream request.
- Never forward unrelated generic image fields such as `quality`, `style`, `background`, `image_detail`, or `output_format`.
- Treat the successful upstream body as OpenAI-compatible and preserve upstream fields including `id`, `created`, `finish_reason`, and `seed`.

Validation errors are local HTTP 400 results and must not issue a fetch. Upstream non-2xx responses continue through the existing image-core error parser and account fallback behavior.

JSON numeric literals `1` and `1.0` parse to the same integer value and are accepted for `n`; a string such as `"1"`, a fractional number, zero, or any other number is rejected.

### Dashboard Parameter Metadata

Extend image model metadata with an optional, generic `paramConfig` object rather than branching on `providerId === "step-plan"` inside UI components. The existing model `params` array remains the authoritative ordered list of request-field keys. `paramConfig` is keyed by those field names and may override or supply the UI definition for each key. A complete standalone model definition contains at least `label` and one supported `type`; a `select` definition also contains `options`:

```js
{
  params: ["n", "size", "response_format", "seed", "steps", "cfg_scale", "negative_prompt", "text_mode"],
  paramConfig: {
    n: { label: "n", type: "number", default: 1, min: 1, max: 1, step: 1 },
    size: { label: "Size", type: "select", default: "1024x1024", options: ["1024x1024"] },
    text_mode: { label: "Text mode", type: "boolean", default: false }
  }
}
```

For each key in `params`, the dashboard resolves its field definition by shallow-merging the matching global `KIND_EXAMPLE_CONFIG.image.extraFields` definition, when present, with `paramConfig[key]`; model metadata wins. Arrays such as `options` are replaced as whole values and are never concatenated or merged element-by-element. A key with neither a global definition nor a complete standalone model definition is not rendered and must not enter the request. Keys absent from `params` are never rendered or submitted regardless of global defaults. A default of `""` means optional and omitted from the request until the user supplies a value. Boolean `false` and numeric zero are not empty and are submitted.

When model selection changes, the example card resets parameter state to the newly selected model's resolved defaults. It does not retain values from the previous model. This deterministic reset prevents stale values and is the behavior covered by tests.

For `step-image-edit-2`, the dashboard must expose:

- `n`, fixed at 1.
- `size`, defaulting to `1024x1024` with only the five documented choices.
- `response_format`, with `url` and `b64_json` choices.
- `seed`, numeric and optional.
- `steps`, numeric, default 8, range 1-50.
- `cfg_scale`, numeric, default 1.0, range 1.0-10.0, supporting decimal input.
- `negative_prompt`, text and optional.
- `text_mode`, boolean, default false.

The registry model must use this complete metadata object:

```js
{
  id: "step-image-edit-2",
  name: "Step Image Edit 2",
  kind: "image",
  params: ["n", "size", "response_format", "seed", "steps", "cfg_scale", "negative_prompt", "text_mode"],
  paramConfig: {
    n: { label: "n", type: "number", default: 1, min: 1, max: 1, step: 1 },
    size: {
      label: "Size",
      type: "select",
      default: "1024x1024",
      options: ["1024x1024", "768x1360", "896x1184", "1360x768", "1184x896"]
    },
    response_format: { label: "Format", type: "select", default: "url", options: ["url", "b64_json"] },
    seed: { label: "Seed", type: "number", default: "", min: 0, max: 2147483647, step: 1 },
    steps: { label: "Steps", type: "number", default: 8, min: 1, max: 50, step: 1 },
    cfg_scale: { label: "CFG scale", type: "number", default: 1.0, min: 1.0, max: 10.0, step: 0.1 },
    negative_prompt: { label: "Negative prompt", type: "text", default: "" },
    text_mode: { label: "Text mode", type: "boolean", default: false }
  }
}
```

Number fields must be range-validated before Run submits a request. A number field whose `min` equals `max` is rendered as a disabled fixed value and the request builder always submits that configured value. Any other invalid numeric value prevents Run and produces a local form error; HTML attributes alone are not considered validation.

The generic example card must construct requests only from parameters declared by the selected model. Defaults belonging to hidden or unsupported image fields must not leak into the request. When the selected model changes, the form must reconcile values with the new model's parameter definitions so that stale invalid values are not submitted.

This intentionally changes existing dashboard example requests: image models currently receive non-empty global defaults even when their `params` metadata does not declare those fields. After this change, those leaked fields are removed. For example, `black-forest-labs/flux-pro-1.1` continues to submit its declared `n` and `size`, but no longer submits undeclared `quality`, `background`, `image_detail`, or `output_format`. This is an intended bug fix, not a compatibility regression.

The resulting Step Plan example request must not contain `size: "auto"`, `n` greater than 1, or unrelated OpenAI image fields.

### Safe Credential Validation

The generic media-provider validation path must honor optional `validateUrl` and `validateMethod` media configuration. When `validateUrl` is configured, it is the sole probe target and failure must never fall back to `baseUrl` or another service endpoint. Legacy service-endpoint probing applies only when validation metadata is absent.

`validateMethod` is distinct from the existing `method`: `method` describes the media service endpoint probe, while `validateMethod` describes the independent validation endpoint. When `validateUrl` exists and `validateMethod` is omitted, validation defaults to GET. Step Plan declares GET explicitly.

For Step Plan it must:

- Send a GET request to `https://api.stepfun.com/step_plan/v1/models` with the Bearer API key.
- Send no request body.
- Never call `/images/generations` while adding or validating a connection.
- Accept the credential only for a 2xx response. Strict 2xx semantics apply only to providers with `validateUrl`.
- Report 401 or 403 as an invalid credential.
- Treat every other non-2xx response, timeout, or network error as validation failure and never report the credential as valid; retain the route's existing error-response contract rather than inventing a new connection status.
- Preserve the existing behavior for media providers without validation metadata: their legacy probes continue to treat every status except 401/403 as accepted.

### Existing Request Features

The implementation must continue using the existing image handler and core so these behaviors remain available without provider-specific duplication:

- Local 9Router API-key validation.
- Preferred connection selection through `x-connection-id`.
- Multiple Step Plan account fallback.
- Model combo fallback when a combo references `step-plan/step-image-edit-2`.
- JSON URL or base64 output.
- Existing `?response_format=binary` conversion of the first returned image.

Binary behavior is verified at two layers: image-core tests cover actual URL/base64-to-binary conversion, while app-handler tests mock the core and verify that `?response_format=binary` is parsed and forwarded as `binaryOutput: true`.

## Observable Requirements

### R1: Provider Discovery

`step-plan` appears in the dashboard Text to Image provider list and in image-model discovery. Its only model is addressable as `step-plan/step-image-edit-2`.

### R2: Connection Management

A user can create and select one or more Step Plan API-key connections through the existing provider UI and provider API without a database migration or provider-specific credential form. Automated coverage proves the registry makes `step-plan` eligible for the generic API-key creation path and that preferred/multiple connection selection reaches the existing image handler.

### R3: Safe Validation

Credential validation initiated by the connection-creation UI, and explicit credential validation, perform only an authenticated GET against the Step Plan models endpoint and never incur an image-generation request. The connection persistence API itself does not need to make an upstream request.

### R4: Basic Generation

A valid local request containing `model: "step-plan/step-image-edit-2"` and a prompt submits one authenticated request to the Step Plan generation endpoint and returns the upstream OpenAI-compatible image body.

### R5: Advanced Parameters

All supported Step Plan generation fields are forwarded with their explicit values, including valid falsey values. Unsupported fields are not forwarded.

### R6: Local Validation

Invalid prompt length, count, size, response format, seed, steps, guidance scale, negative prompt length, or text-mode type produces a local 400 response without contacting Step Plan.

### R7: Dashboard Correctness

The dashboard exposes Step Plan's supported parameters with Step Plan-specific defaults and constraints, and generated examples contain only parameters supported by the selected model.

### R8: Response Compatibility

Both `url` and `b64_json` results are returned without dropping Step Plan's `id`, `finish_reason`, or `seed`. Existing binary output continues to work using the first returned image. An HTTP 2xx body that is not valid JSON follows the existing image-core parse-error path and returns 502; structural response validation beyond valid JSON remains out of scope.

### R9: Error Compatibility

Upstream authentication, rate-limit, server, invalid-JSON 2xx, and network failures follow existing image-core error formatting and account fallback behavior.

### R10: No Image-Editing Claim

The provider and model are not presented as supporting image editing, and no local image-editing endpoint is introduced.

## Scenarios

### Scenario: Generate With Defaults

Given an active Step Plan API-key connection, when a client sends a prompt with `model: "step-plan/step-image-edit-2"`, then 9Router sends one request with `n: 1`, does not send `size: "auto"`, authenticates with the stored key, and returns the generated image response.

### Scenario: Generate With All Advanced Fields

Given valid values for size, response format, seed, steps, guidance scale, negative prompt, and text mode, when the request is handled, then every supplied field reaches Step Plan unchanged and unrelated image fields do not.

### Scenario: Preserve Falsey Values

Given `seed: 0`, `negative_prompt: ""`, and `text_mode: false`, when the request is handled, then the adapter preserves those explicitly supplied values rather than removing them through truthiness checks.

### Scenario: Reject Invalid Count

Given `n: 2`, when the request is handled, then 9Router returns HTTP 400 and does not call the upstream API.

### Scenario: Reject Invalid Size

Given `size: "1536x1024"`, when the request is handled, then 9Router returns HTTP 400 and does not reinterpret or reverse the dimensions.

### Scenario: Dashboard Request

Given the Step Plan model is selected in the image example card, when a user runs the default example, then the body contains exactly the Step model, prompt, `n: 1`, `size: "1024x1024"`, `response_format: "url"`, `steps: 8`, `cfg_scale: 1.0`, and `text_mode: false`; it omits empty `seed` and `negative_prompt` and contains no unsupported field.

### Scenario: Existing Image Model Request Cleanup

Given `black-forest-labs/flux-pro-1.1` is selected, when a user runs its dashboard example, then the request retains its declared `n` and `size` fields and omits undeclared global defaults including `quality`, `background`, `image_detail`, and `output_format`.

### Scenario: Validate API Key

Given a user saves a Step Plan API key, when credential validation runs, then 9Router calls only the Step Plan models endpoint with GET and Bearer authentication. A 401 or 403 marks the key invalid.

### Scenario: Validation Service Failure

Given the Step Plan models endpoint returns a non-2xx status other than 401/403, times out, or cannot be reached, when credential validation runs, then 9Router does not report the credential as valid and does not fall back to an image-generation probe.

### Scenario: URL and Base64 Results

Given Step Plan returns either a URL result or a base64 result, when generation succeeds, then the local JSON response retains the corresponding field plus `finish_reason` and `seed`.

### Scenario: Account Fallback

Given multiple Step Plan connections and the selected account receives a retryable upstream failure, when existing fallback policy authorizes a retry, then the handler selects another Step Plan account without provider-specific fallback code.

## Impacted Areas

The approved production-code scope is limited to the following expected implementation areas:

- `open-sse/providers/registry/step-plan.js`
- `open-sse/providers/registry/index.js`
- `open-sse/handlers/imageProviders/stepPlan.js`
- `open-sse/handlers/imageProviders/index.js`
- `src/app/api/providers/validate/route.js`
- `src/app/(dashboard)/dashboard/media-providers/[kind]/[id]/components/exampleShared.js`
- `src/app/(dashboard)/dashboard/media-providers/[kind]/[id]/components/GenericExampleCard.js`
- An extracted pure parameter-resolution/request-construction helper in the same component directory, if needed to make dashboard behavior directly testable

The approved test and snapshot scope is limited to:

- `tests/unit/image-generation.test.js`
- `tests/unit/image-generation-handler.test.js`, containing new `vi.mock`-based app-handler scaffolding
- Focused image-handler, provider-creation, provider-validation, and dashboard request-construction tests, using existing test locations where available
- Registry consistency tests
- `tests/__baseline__/alias-baseline.json` if the provider/model key changes the alias baseline

Additional files require an explicit spec amendment before implementation.

No production database schema file, chat translator, executor, or image generation route should need modification.

## Compatibility and Risks

- Adding a new provider/model key intentionally changes provider and alias discovery snapshots.
- Filtering dashboard request fields by selected-model metadata may affect other media model examples; tests must demonstrate that existing supported fields remain available.
- Removing undeclared global defaults from existing image-model example requests is intentional; representative regression tests must prove declared fields remain and leaked fields disappear.
- The StepFun documentation defines dimensions as height by width. The adapter must treat documented strings as opaque enum values rather than using generic width/height helpers.
- Credential validation must not regress providers that rely on existing POST probes.
- Existing binary URL fetching and fallback policy have broader security and duplicate-request risks, but changing those systems is outside this specification.

## Acceptance

This change is complete when all observable requirements are covered by automated tests, including handler-level connection/fallback behavior and binary-flag propagation plus core-level binary conversion; targeted tests pass; applicable baselines are deliberately updated and pass; lint reports no new errors in changed files; and no image generation request is made during Step Plan credential validation.
