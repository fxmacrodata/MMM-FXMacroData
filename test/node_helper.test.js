/*
 * Tests for node_helper.js without a running MagicMirror².
 *
 * MagicMirror² provides the "logger" and "node_helper" modules at runtime, so
 * small stand-ins are registered here before the helper is loaded. fetch is
 * replaced with a stub so no request leaves the machine.
 */
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const quietLog = { log () {}, info () {}, warn () {}, error () {} };
const fakeNodeHelper = {
	create (definition) {
		return class {
			constructor () {
				Object.assign(this, definition);
				this.name = "MMM-FXMacroData";
				this.sent = [];
			}

			sendSocketNotification (notification, payload) {
				this.sent.push({ notification, payload });
			}
		};
	}
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === "logger") return quietLog;
	if (request === "node_helper") return fakeNodeHelper;
	return originalLoad.call(this, request, parent, isMain);
};
const HelperClass = require("../node_helper.js");
Module._load = originalLoad;

const realFetch = global.fetch;
const savedEnv = process.env.FXMACRODATA_API_KEY;

function jsonResponse (status, body) {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body
	};
}

function futureCalendar (currency) {
	const soon = Math.floor(Date.now() / 1000) + 3600;
	return {
		currency,
		data: [{ announcement_datetime: soon, release: "inflation", name: "Inflation (CPI)", event_importance: "high" }]
	};
}

function makeHelper (moduleConfig) {
	global.config = { modules: [{ module: "clock" }, { module: "MMM-FXMacroData", config: moduleConfig || {} }] };
	const helper = new HelperClass();
	helper.start();
	return helper;
}

describe("node_helper", () => {
	let calls;

	beforeEach(() => {
		calls = [];
		delete process.env.FXMACRODATA_API_KEY;
	});

	afterEach(() => {
		global.fetch = realFetch;
		delete global.config;
		if (savedEnv === undefined) delete process.env.FXMACRODATA_API_KEY;
		else process.env.FXMACRODATA_API_KEY = savedEnv;
	});

	it("sends the API key only as the X-API-Key header", async () => {
		global.fetch = async (url, options) => {
			calls.push({ url, headers: options.headers });
			return url.includes("/calendar/")
				? jsonResponse(200, futureCalendar("EUR"))
				: jsonResponse(200, { name: "Inflation", data: [{ val: 2.1 }] });
		};
		const helper = makeHelper({ apiKey: "test-key-123" });
		await helper.refresh({ settings: { identifier: "module_1_MMM-FXMacroData", currencies: ["EUR"], indicators: ["inflation"], updateInterval: 900000 } });

		assert.equal(calls.length, 2);
		for (const call of calls) {
			assert.equal(call.headers["X-API-Key"], "test-key-123");
			assert.ok(!call.url.includes("test-key-123"), "key must not appear in the URL");
			assert.ok(!call.url.includes("api_key"), "no api_key query parameter");
		}
		assert.equal(calls[0].url, "https://api.fxmacrodata.com/v1/calendar/EUR");
		assert.equal(calls[1].url, "https://api.fxmacrodata.com/v1/announcements/EUR/inflation?limit=1");

		const { payload } = helper.sent.at(-1);
		assert.equal(payload.hasApiKey, true);
		assert.ok(!JSON.stringify(payload).includes("test-key-123"), "key must not be sent to the browser");
		assert.equal(payload.releases.length, 1);
		assert.equal(payload.latest[0].value, 2.1);
	});

	it("works without a key and sends no X-API-Key header", async () => {
		global.fetch = async (url, options) => {
			calls.push({ url, headers: options.headers });
			return jsonResponse(200, futureCalendar("USD"));
		};
		const helper = makeHelper({});
		await helper.refresh({ settings: { identifier: "module_1_MMM-FXMacroData", currencies: ["USD"], indicators: [], updateInterval: 900000 } });
		assert.equal(calls.length, 1);
		assert.equal(calls[0].headers["X-API-Key"], undefined);
		assert.equal(helper.sent.at(-1).payload.hasApiKey, false);
	});

	it("falls back to the FXMACRODATA_API_KEY environment variable and ignores unfilled placeholders", () => {
		process.env.FXMACRODATA_API_KEY = "env-key";
		const helper = makeHelper({ apiKey: "${SECRET_FXMACRODATA_API_KEY}" });
		assert.equal(helper.resolveApiKey("module_1_MMM-FXMacroData"), "env-key");
	});

	it("reports a 401 as a key error and stops calling that currency", async () => {
		global.fetch = async (url) => {
			calls.push(url);
			return jsonResponse(401, { error: "api_key_required" });
		};
		const helper = makeHelper({});
		await helper.refresh({ settings: { identifier: "module_1_MMM-FXMacroData", currencies: ["EUR"], indicators: ["inflation", "policy_rate"], updateInterval: 900000 } });
		assert.equal(calls.length, 1, "indicator calls are skipped after a 401");
		assert.deepEqual(helper.sent.at(-1).payload.errors, [{ currency: "EUR", key: "ERROR_KEY_REQUIRED" }]);
	});

	it("shares one in-flight request per currency and caches results", async () => {
		let release;
		const gate = new Promise((resolve) => { release = resolve; });
		global.fetch = async (url) => {
			calls.push(url);
			await gate;
			return jsonResponse(200, futureCalendar("USD"));
		};
		const helper = makeHelper({});
		const settings = { identifier: "module_1_MMM-FXMacroData", currencies: ["USD"], indicators: [], updateInterval: 900000 };
		const first = helper.loadCurrency("USD", settings, null);
		const second = helper.loadCurrency("USD", settings, null);
		assert.equal(first, second);
		release();
		await first;
		await helper.loadCurrency("USD", settings, null);
		assert.equal(calls.length, 1, "second load is served from cache");
	});

	it("keeps showing the last good data when a refresh fails", async () => {
		let fail = false;
		global.fetch = async () => {
			if (fail) throw new Error("socket hang up");
			return jsonResponse(200, futureCalendar("USD"));
		};
		const helper = makeHelper({});
		const settings = { identifier: "module_1_MMM-FXMacroData", currencies: ["USD"], indicators: [], updateInterval: 900000 };
		const instance = { settings };
		await helper.refresh(instance);
		fail = true;
		helper.cache.get("USD|calendar").fetchedAt = 0; // force a refetch
		await helper.refresh(instance);
		const { payload } = helper.sent.at(-1);
		assert.equal(payload.releases.length, 1);
		assert.deepEqual(payload.errors, []);
	});
});
