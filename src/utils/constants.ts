export const TOKEN_HEADER_NAME = "x-bound-auth-token";
export const FETCH_TOKEN_URL = "https://apis.roblox.com/hba-service/v1/getServerNonce";
export const FETCH_TOKEN_METADATA_URL = "https://www.roblox.com/reference/blank";
export const FETCH_TOKEN_METADATA_SELECTOR = 'meta[name="hardware-backed-authentication-data"]';
export const AUTH_TOKEN_SEPARATOR = "|";
export const MATCH_ROBLOX_URL_BASE = ".roblox.com";

export const TOKEN_SIGNATURE_ALGORITHM: EcdsaParams & { hash: { name: string } } = {
    name: "ECDSA",
    hash: { name: "SHA-256" }
};