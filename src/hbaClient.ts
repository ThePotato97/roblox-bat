import { AUTH_TOKEN_SEPARATOR, FETCH_TOKEN_METADATA_SELECTOR, FETCH_TOKEN_METADATA_URL, TOKEN_HEADER_NAME, MATCH_ROBLOX_URL_BASE } from "./utils/constants.ts";
import { getCryptoKeyPairFromDB, hashStringSha256, signWithKey } from "./utils/crypto.ts";
import { filterObject } from "./utils/filterObject.ts";
import { parseDOM } from "./utils/parseDOM.ts";

export type HBAClientConstProps = {
    /**
     * The fetch to be wrapped.
     */
    fetch?: (url: string, params?: RequestInit) => Promise<Response>;
    /**
     * Base request headers.
     */
    headers?: Record<string, unknown> | Headers;
    /**
     * The request cookie. This would generally just be used for getting the browser tracker id (btid) for the DB key name.
     */
    cookie?: string;
    /**
     * The target ID for the object store in the indexed DB.
     */
    targetId?: string;
    /**
     * Whether the current context is on the Roblox site, and will use credentials.
     */
    onSite?: boolean;
    /**
     * A supplied CryptoKeyPair.
     */
    keys?: CryptoKeyPair;
    /**
     * The base URL as a string of the client.
     */
    baseUrl?: string;
};

export type APISiteWhitelistItem = {
    apiSite: string;
    sampleRate: number;
};

export type APISiteExemptlistItem = {
    apiSite: string;
};

export type TokenMetadata = {
    isSecureAuthenticationIntentEnabled: boolean;
    isBoundAuthTokenEnabledForAllUrls: boolean;
    boundAuthTokenWhitelist?: APISiteWhitelistItem[];
    boundAuthTokenExemptlist?: APISiteExemptlistItem[];
    hbaIndexedDbName: string;
    hbaIndexedDbObjStoreName: string;
};

/**
 * Hardware-backed authentication client. This handles generating the headers required.
 */
export class HBAClient {
    private readonly _fetchFn?: (url: string, params?: RequestInit) => Promise<Response>;
    public cookie?: string;
    public targetId = "";
    public cachedTokenMetadata: TokenMetadata | Promise<TokenMetadata | null> | undefined;
    public headers: Record<string, unknown> = {};
    public cryptoKeyPair: CryptoKeyPair | Promise<CryptoKeyPair | null> | undefined;
    public onSite = false;
    public suppliedCryptoKeyPair: CryptoKeyPair | undefined;
    public baseUrl: string | undefined;

    /**
     * General fetch wrapper for the client. Not for general public use.
     * @param url - The target URL
     * @param params - The request parameters
     */
    public fetch(url: string, params?: RequestInit) {
        const headers = new Headers(filterObject(this.headers) as Record<string, string>);
        if (params?.headers) {
            const headerParams = new Headers(params.headers);
            headerParams.forEach((value, key) => {
                headers.set(key, value);
            })
        }

        const init = {
            ...params,
            headers
        };
        if (this.onSite) {
            // @ts-ignore: just incase ts is annoying
            init.credentials = "include";
        } else if (this.cookie) {
            headers.set("cookie", this.cookie);
        }

        return (this._fetchFn ?? fetch)(url, init);
    }

    /**
     * Generate the base headers required, it may be empty or only include `x-bound-auth-token`
     * @param requestUrl - The target request URL, will be checked if it's supported for HBA.
     * @param body - The request body. If the method does not support a body, leave it undefined.
     */
    public async generateBaseHeaders(requestUrl: string | URL, body?: unknown): Promise<Record<string, string>> {
        if (!await this.isUrlIncludedInWhitelist(requestUrl)) {
            return {};
        }
        const token = await this.generateBAT(body);
        if (!token) {
            return {};
        }

        return {
            [TOKEN_HEADER_NAME]: token
        }
    }

    /**
     * Get HBA token metadata.
     * @param uncached - Whether it should fetch uncached.
     */
    public async getTokenMetadata(uncached?: boolean): Promise<TokenMetadata | null> {
        if (!uncached && await this.cachedTokenMetadata) {
            return this.cachedTokenMetadata!;
        }

        const promise = (async (): Promise<TokenMetadata | null> => {
            let doc: Document;
            if (uncached || !("document" in globalThis) || !document.querySelector(FETCH_TOKEN_METADATA_SELECTOR)) {
                const res = await this.fetch(FETCH_TOKEN_METADATA_URL).then(res => res.text());
                doc = parseDOM(res);
            } else {
                doc = document;
            }
            const el = doc?.querySelector?.(FETCH_TOKEN_METADATA_SELECTOR);

            if (!el) {
                return null;
            }

            try {
                const isSecureAuthenticationIntentEnabled = el.getAttribute("data-is-secure-authentication-intent-enabled") === "true";
                const isBoundAuthTokenEnabledForAllUrls = el.getAttribute("data-is-bound-auth-token-enabled") === "true";
                const boundAuthTokenWhitelist = JSON.parse(el.getAttribute("data-bound-auth-token-whitelist")!)?.Whitelist?.map((item: {
                    sampleRate: string;
                }) => ({
                    ...item,
                    sampleRate: Number(item.sampleRate)
                }))
                const boundAuthTokenExemptlist = JSON.parse(el.getAttribute("data-bound-auth-token-exemptlist")!)?.Exemptlist;
                const hbaIndexedDbName = el.getAttribute("data-hba-indexed-db-name")!;
                const hbaIndexedDbObjStoreName = el.getAttribute("data-hba-indexed-db-obj-store-name")!;

                const tokenMetadata = {
                    isSecureAuthenticationIntentEnabled,
                    isBoundAuthTokenEnabledForAllUrls,
                    boundAuthTokenWhitelist,
                    boundAuthTokenExemptlist,
                    hbaIndexedDbName,
                    hbaIndexedDbObjStoreName
                };
                this.cachedTokenMetadata = tokenMetadata;

                return tokenMetadata;
            } catch {
                this.cachedTokenMetadata = undefined;
                return null;
            }
        })();

        this.cachedTokenMetadata = promise;
        return promise;
    }

    /**
     * Fetch the public-private crypto key pair from the indexed DB store.
     * @param uncached - Whether it should fetch uncached.
     */
    public async getCryptoKeyPair(uncached?: boolean): Promise<CryptoKeyPair | null> {
        if (this.suppliedCryptoKeyPair) {
            return this.suppliedCryptoKeyPair;
        }
        if (!uncached && await this.cryptoKeyPair) {
            return this.cryptoKeyPair!;
        }
        if (!("indexedDB" in globalThis) || !this.targetId) {
            return null;
        }

        const promise = (async (): Promise<CryptoKeyPair | null> => {
            const metadata = await this.getTokenMetadata(uncached);
            if (!metadata) {
                return null;
            }

            try {
                const pair = await getCryptoKeyPairFromDB(metadata.hbaIndexedDbName, metadata.hbaIndexedDbObjStoreName, this.targetId);
                this.cryptoKeyPair = pair ?? undefined;

                return pair;
            } catch {
                this.cryptoKeyPair = undefined;
                return null;
            }
        })();
        this.cryptoKeyPair = promise;

        return promise;
    }

    /**
     * Generate the bound auth token given a body.
     * @param body - The request body. If the method does not support a body, leave it undefined.
     */
    public async generateBAT(body?: unknown): Promise<string | null> {
        const pair = await this.getCryptoKeyPair();
        if (!pair?.privateKey) {
            return null;
        }
        const timestamp = Math.floor(Date.now() / 1000).toString();
        let strBody: string | undefined;
        if (typeof body === "object") {
            strBody = JSON.stringify(body);
        } else if (typeof body === "string") {
            strBody = body;
        }

        const hashedBody = await hashStringSha256(strBody);
        const payloadToSign = [hashedBody, timestamp].join(AUTH_TOKEN_SEPARATOR);
        const signature = await signWithKey(pair.privateKey, payloadToSign);

        return [hashedBody, timestamp, signature].join(AUTH_TOKEN_SEPARATOR);
    }

    /**
     * Check whether the URL is supported for bound auth tokens.
     * @param url - The target URL.
     */
    public async isUrlIncludedInWhitelist(tryUrl: string | URL) {
        const url = tryUrl.toString();
        if (!url.toString().includes(MATCH_ROBLOX_URL_BASE)) {
            return false;
        }
        if (this.onSite && this.baseUrl) {
            try {
                const targetUrl = new URL(url, this.baseUrl);
                if (!targetUrl.href.includes(MATCH_ROBLOX_URL_BASE)) {
                    return false;
                }
            } catch {/* empty */ }
        }
        const metadata = await this.getTokenMetadata();

        return !!metadata && (
            metadata.isBoundAuthTokenEnabledForAllUrls ||
            metadata.boundAuthTokenWhitelist?.some(item => url.includes(item.apiSite) && (Math.floor(Math.random() * 100) < item.sampleRate))
        ) &&
            !metadata.boundAuthTokenExemptlist?.some(item => url.includes(item.apiSite))
    }

    public constructor({
        fetch,
        headers,
        cookie,
        targetId,
        onSite,
        keys,
        baseUrl,
    }: HBAClientConstProps = {}) {
        if (fetch) {
            this._fetchFn = fetch;
        }
        if (headers) {
            // @ts-ignore: fine
            this.headers = headers instanceof Headers ? Object.fromEntries(headers.entries()) : headers;
        }

        if (cookie) {
            this.cookie = cookie;
        }

        if (baseUrl) {
            this.baseUrl = baseUrl;
        }

        if (onSite) {
            this.onSite = onSite;
            if (globalThis?.location?.href && !baseUrl) {
                this.baseUrl = globalThis.location.href;
            }
        }

        if (keys) {
            this.suppliedCryptoKeyPair = keys;
        }

        const setCookie = cookie ?? globalThis?.document?.cookie;
        if (targetId) {
            this.targetId = targetId;
        } else if (setCookie) {
            const btid = setCookie.match(/browserid=(\d+)/i)?.[1]
            if (btid) {
                this.targetId = btid;
            }
        }
    }
}