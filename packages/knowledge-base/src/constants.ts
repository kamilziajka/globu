import pkg from "../../../package.json" with { type: "json" };

export const VERSION = pkg.version;
export const PLUGIN_NAME = "knowledge-base";
export const DEFAULT_BASE_DIRNAME = "wiki";
export const INDEX_FILENAME = "index.md";
export const LOG_FILENAME = "log.md";
export const OKF_VERSION = "0.2";
export const OKF_SPEC_URL = "https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md";
export const RESERVED_FILENAMES = new Set([INDEX_FILENAME, LOG_FILENAME]);
