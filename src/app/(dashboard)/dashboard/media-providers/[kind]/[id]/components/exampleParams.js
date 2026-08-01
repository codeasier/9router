const SUPPORTED_FIELD_TYPES = new Set(["select", "text", "number", "boolean"]);

export const IMAGE_EXAMPLE_FIELDS = [
  { key: "n", label: "n", type: "number", default: 1, min: 1, max: 4 },
  { key: "size", label: "Size", type: "select", default: "auto", options: ["auto", "1024x1024", "1024x1536", "1536x1024", "1024x1792", "1792x1024"] },
  { key: "quality", label: "Quality", type: "select", default: "auto", options: ["auto", "low", "medium", "high", "standard", "hd"] },
  { key: "background", label: "Background", type: "select", default: "auto", options: ["auto", "transparent", "opaque"] },
  { key: "style", label: "Style", type: "select", default: "", options: ["", "vivid", "natural"] },
  { key: "response_format", label: "Format", type: "select", default: "", options: ["", "url", "b64_json"] },
  { key: "image_detail", label: "Image Detail", type: "select", default: "high", options: ["auto", "low", "high", "original"] },
  { key: "output_format", label: "Codec", type: "select", default: "png", options: ["png", "jpeg", "webp"] },
];

function isCompleteField(field) {
  return typeof field?.label === "string"
    && SUPPORTED_FIELD_TYPES.has(field.type)
    && (field.type !== "select" || Array.isArray(field.options));
}

export function resolveParamFields(globalFields = [], model) {
  if (!Array.isArray(model?.params)) return [];

  const globalByKey = new Map(globalFields.map((field) => [field.key, field]));
  return model.params.flatMap((key) => {
    const globalField = globalByKey.get(key);
    const modelField = model.paramConfig?.[key];
    const field = { ...globalField, ...modelField, key };
    return isCompleteField(field) ? [field] : [];
  });
}

export function isFixedNumberField(field) {
  return field.type === "number" && field.min === field.max && field.min !== undefined;
}

export function getParamDefaults(fields) {
  return fields.reduce((values, field) => {
    values[field.key] = isFixedNumberField(field)
      ? field.min
      : (field.default ?? "");
    return values;
  }, {});
}

function isStepAligned(value, field) {
  if (!(field.step > 0)) return true;
  const base = field.min ?? 0;
  const steps = (value - base) / field.step;
  return Math.abs(steps - Math.round(steps)) < 1e-9;
}

export function buildParamRequest(fields, values = {}) {
  const params = {};

  for (const field of fields) {
    const value = isFixedNumberField(field) ? field.min : values[field.key];
    const isEmpty = value === "" || value === null || value === undefined;

    if (isEmpty) {
      if (field.default === "") continue;
      return { params, error: `${field.label} is required.` };
    }

    if (field.type === "number") {
      const numberValue = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(numberValue)
        || (field.min !== undefined && numberValue < field.min)
        || (field.max !== undefined && numberValue > field.max)
        || !isStepAligned(numberValue, field)) {
        return { params, error: `${field.label} must be a valid number within its configured constraints.` };
      }
      params[field.key] = numberValue;
      continue;
    }

    if (field.type === "boolean") {
      if (typeof value !== "boolean") {
        return { params, error: `${field.label} must be true or false.` };
      }
      params[field.key] = value;
      continue;
    }

    if (field.type === "select" && !field.options.includes(value)) {
      return { params, error: `${field.label} must use one of the available options.` };
    }

    params[field.key] = value;
  }

  return { params, error: "" };
}
