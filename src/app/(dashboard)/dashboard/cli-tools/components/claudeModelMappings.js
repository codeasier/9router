export function applyClaudeModelMappings(env, defaultModels, modelMappings) {
  defaultModels.forEach((model) => {
    const targetModel = modelMappings[model.alias];
    if (targetModel && model.envKey) env[model.envKey] = targetModel;
  });

  return env;
}
