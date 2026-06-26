/**
 * CDP API Key Auth for x402 Facilitator
 *
 * Generates ES256 JWTs using the Coinbase Developer Platform API key.
 * Uses jose (same as @coinbase/cdp-sdk) for JWT signing.
 *
 * CDP JWT claims:
 *   sub: apiKeyId (the key name path)
 *   iss: "cdp"
 *   uris: ["METHOD HOST PATH"] — must match the request being made
 *   Header: { alg: "ES256", kid: keyName, typ: "JWT", nonce: randomHex }
 *
 * Key format from cdp_api_key.json:
 *   name: "organizations/{org_id}/apiKeys/{key_id}"
 *   privateKey: "[REDACTED PRIVATE KEY]"
 *   (privateKey is SEC1/EC format, converted to PKCS8 internally)
 */

const { importPKCS8, SignJWT } = require("jose");
const crypto = require("crypto");

const CDP_HOST = "api.cdp.coinbase.com";
const CDP_BASE_PATH = "/platform/v2/x402";

// Map x402 facilitator operation → CDP HTTP request
const PATH_MAP = {
  supported: { method: "GET",  path: `${CDP_BASE_PATH}/supported` },
  verify:    { method: "POST", path: `${CDP_BASE_PATH}/verify` },
  settle:    { method: "POST", path: `${CDP_BASE_PATH}/settle` },
};

/**
 * Create auth headers for CDP facilitator.
 *
 * @param {string} keyName — CDP API key name (organizations/.../apiKeys/...)
 * @param {string} privateKeyPEM — EC private key in PEM format (SEC1 or PKCS8)
 * @returns {function} createAuthHeaders function for x402 facilitator config
 */
function createCDPAuthHeaders(keyName, privateKeyPEM) {
  let cachedKey = null;

  // Convert SEC1 (EC PRIVATE KEY) to PKCS8 if needed
  let pkcs8Pem = privateKeyPEM;
  if (privateKeyPEM.includes("EC PRIVATE KEY")) {
    const ecKeyObj = crypto.createPrivateKey({ key: privateKeyPEM, format: "pem" });
    const pkcs8Der = ecKeyObj.export({ type: "pkcs8", format: "der" });
    pkcs8Pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(pkcs8Der).toString("base64").match(/.{1,64}/g).join("\n")}\n-----END PRIVATE KEY-----`;
  }

  async function getKey() {
    if (!cachedKey) {
      cachedKey = await importPKCS8(pkcs8Pem, "ES256");
    }
    return cachedKey;
  }

  return async () => {
    const ecKey = await getKey();
    const now = Math.floor(Date.now() / 1000);
    const nonceVal = crypto.randomBytes(16).toString("hex");

    const headers = {};

    for (const [facilitatorOp, reqInfo] of Object.entries(PATH_MAP)) {
      const claims = {
        sub: keyName,
        iss: "cdp",
        uris: [`${reqInfo.method} ${CDP_HOST}${reqInfo.path}`],
      };

      const token = await new SignJWT(claims)
        .setProtectedHeader({ alg: "ES256", kid: keyName, typ: "JWT", nonce: nonceVal })
        .setIssuedAt(now)
        .setNotBefore(now)
        .setExpirationTime(now + 120)
        .sign(ecKey);

      headers[facilitatorOp] = { Authorization: "Bearer " + token };
    }

    return headers;
  };
}

module.exports = { createCDPAuthHeaders };
