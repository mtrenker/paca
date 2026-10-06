// Model access goes through Pi's own ModelRuntime: the same credentials (auth.json, environment
// keys), models.json (for example llama.cpp) and default model as the pi CLI. Paca adds nothing.
import { join } from "node:path";
import { getAgentDir, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";

export async function openModels(dataDir, configured) {
	// The model catalog cache is Paca's own; credentials stay in Pi's locked credential store.
	const models = await ModelRuntime.create({ modelsStorePath: join(dataDir, "models-store.json") });
	let ref = configured;
	if (!ref) {
		const settings = SettingsManager.create(process.cwd(), getAgentDir());
		ref = settings.getDefaultProvider() && settings.getDefaultModel() ? `${settings.getDefaultProvider()}/${settings.getDefaultModel()}` : undefined;
	}
	if (!ref) throw new Error("No model: set \"model\" (provider/modelId) in the config or a default model in Pi");
	const slash = ref.indexOf("/");
	const model = { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
	if (!models.getModel(model.provider, model.modelId)) throw new Error(`Pi does not know the model ${ref}`);
	if (!models.hasConfiguredAuth(model.provider)) throw new Error(`Pi has no credential for ${model.provider}; use /login in pi or the provider's environment variable`);
	return { models, model, label: ref };
}
