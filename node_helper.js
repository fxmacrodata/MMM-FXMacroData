/*
 * Node helper for MMM-FXMacroData.
 *
 * All API calls happen here, on the MagicMirror² server. The API key is read
 * from the server-side config (or the FXMACRODATA_API_KEY environment
 * variable) and is only ever sent to the API as the X-API-Key header. It is
 * never put in a URL and never sent back to the browser.
 */
const Log = require("logger");
const NodeHelper = require("node_helper");
const helpers = require("./fxmd_data.js");

const API_BASE = "https://api.fxmacrodata.com/v1";
const MIN_INTERVAL = 5 * 60 * 1000;
const DEFAULT_INTERVAL = 15 * 60 * 1000;
const REQUEST_TIMEOUT = 20 * 1000;
const VERSION = require("./package.json").version;

module.exports = NodeHelper.create({
	start () {
		Log.log(`Starting node helper for: ${this.name}`);
		this.instances = new Map(); // identifier -> { settings, timer, lastPayload }
		this.cache = new Map(); // "USD|calendar" -> { fetchedAt, result }
		this.inFlight = new Map(); // "USD|inflation,policy_rate" -> Promise
		this.currencyQueue = new Map(); // currency -> last queued Promise
	},

	stop () {
		for (const instance of this.instances.values()) {
			clearInterval(instance.timer);
		}
		this.instances.clear();
	},

	socketNotificationReceived (notification, payload) {
		if (notification !== "FXMD_START" || !payload || !payload.identifier) return;

		const existing = this.instances.get(payload.identifier);
		if (existing) {
			// Another browser connected to the same mirror: hand it the data we
			// already have instead of fetching again.
			if (existing.lastPayload) {
				this.sendSocketNotification("FXMD_DATA", existing.lastPayload);
			}
			return;
		}

		const settings = {
			identifier: payload.identifier,
			currencies: helpers.normalizeCurrencies(payload.currencies),
			indicators: payload.showLatest ? helpers.normalizeIndicators(payload.indicators) : [],
			minImportance: payload.minImportance,
			lookaheadDays: Number(payload.lookaheadDays) || 0,
			maxItems: Number(payload.maxItems) || 0,
			updateInterval: helpers.clampInterval(payload.updateInterval, MIN_INTERVAL, DEFAULT_INTERVAL)
		};

		const instance = { settings, timer: null, lastPayload: null };
		this.instances.set(payload.identifier, instance);
		this.refresh(instance);
		instance.timer = setInterval(() => this.refresh(instance), settings.updateInterval);
	},

	/**
	 * Fetch everything one module instance needs and send it to the browser.
	 * @param {object} instance The instance state created in socketNotificationReceived.
	 */
	async refresh (instance) {
		const { settings } = instance;
		const apiKey = this.resolveApiKey(settings.identifier);
		const results = await Promise.all(settings.currencies.map((currency) => this.loadCurrency(currency, settings, apiKey)));

		const errors = [];
		const releaseLists = [];
		const latest = [];
		for (const result of results) {
			if (result.error) errors.push({ currency: result.currency, key: result.error });
			if (result.calendar) {
				releaseLists.push(helpers.shapeCalendar(result.calendar, {
					now: Date.now(),
					minImportance: settings.minImportance,
					lookaheadDays: settings.lookaheadDays
				}));
			}
			for (const item of result.latest) latest.push(item);
		}

		instance.lastPayload = {
			identifier: settings.identifier,
			fetchedAt: Date.now(),
			hasApiKey: Boolean(apiKey),
			releases: helpers.mergeReleases(releaseLists, settings.maxItems),
			latest,
			errors
		};
		this.sendSocketNotification("FXMD_DATA", instance.lastPayload);
	},

	/**
	 * Load calendar and latest values for one currency. Concurrent callers for
	 * the same currency share one request chain, and results are reused until
	 * the refresh interval has passed.
	 * @param {string} currency Currency code.
	 * @param {object} settings Instance settings.
	 * @param {string|null} apiKey API key or null for keyless access.
	 * @returns {Promise<object>} { currency, calendar, latest, error }
	 */
	loadCurrency (currency, settings, apiKey) {
		const flightKey = `${currency}|${settings.indicators.join(",")}`;
		if (this.inFlight.has(flightKey)) return this.inFlight.get(flightKey);

		// A different module instance may be loading the same currency with a
		// different indicator list. Queue behind it rather than run in parallel;
		// it will usually have filled the cache by the time we run.
		const previous = this.currencyQueue.get(currency) || Promise.resolve();
		const promise = previous
			.catch(() => {})
			.then(() => this.fetchCurrency(currency, settings, apiKey))
			.finally(() => {
				this.inFlight.delete(flightKey);
				if (this.currencyQueue.get(currency) === promise) this.currencyQueue.delete(currency);
			});
		this.inFlight.set(flightKey, promise);
		this.currencyQueue.set(currency, promise);
		return promise;
	},

	async fetchCurrency (currency, settings, apiKey) {
		const result = { currency, calendar: null, latest: [], error: null };
		const maxAge = settings.updateInterval - 30000;

		const calendar = await this.cachedGet(`${currency}|calendar`, maxAge, `/calendar/${encodeURIComponent(currency)}`, apiKey);
		if (calendar.error) {
			result.error = calendar.error;
			// A 401 here means every call for this currency will fail the same way.
			if (calendar.error === "ERROR_KEY_REQUIRED") return result;
		} else {
			result.calendar = calendar.body;
		}

		// One request at a time per currency, to stay well inside rate limits.
		for (const indicator of settings.indicators) {
			const path = `/announcements/${encodeURIComponent(currency)}/${encodeURIComponent(indicator)}?limit=1`;
			const response = await this.cachedGet(`${currency}|${indicator}`, maxAge, path, apiKey);
			if (response.error) {
				if (response.error === "ERROR_NOT_FOUND") continue; // indicator not published for this currency
				result.error = result.error || response.error;
				if (response.error === "ERROR_KEY_REQUIRED" || response.error === "ERROR_RATE_LIMITED") break;
				continue;
			}
			result.latest.push(helpers.shapeLatest(response.body, currency, indicator));
		}
		return result;
	},

	async cachedGet (cacheKey, maxAge, path, apiKey) {
		const cached = this.cache.get(cacheKey);
		if (cached && Date.now() - cached.fetchedAt < maxAge && cached.hadKey === Boolean(apiKey)) {
			return cached.result;
		}
		const result = await this.request(path, apiKey);
		// Keep serving the last good answer if a refresh fails.
		if (!result.error || !cached || cached.result.error) {
			this.cache.set(cacheKey, { fetchedAt: Date.now(), hadKey: Boolean(apiKey), result });
		}
		return result.error && cached && !cached.result.error ? { ...cached.result, stale: true } : result;
	},

	async request (path, apiKey) {
		const headers = {
			Accept: "application/json",
			"User-Agent": `MMM-FXMacroData/${VERSION}`
		};
		if (apiKey) headers["X-API-Key"] = apiKey;

		try {
			const response = await fetch(`${API_BASE}${path}`, {
				headers,
				signal: AbortSignal.timeout(REQUEST_TIMEOUT)
			});
			if (!response.ok) {
				Log.warn(`${path.split("?")[0]} returned HTTP ${response.status}`);
				return { error: helpers.errorKeyForStatus(response.status) };
			}
			return { body: await response.json() };
		} catch (error) {
			Log.error(`Request to ${path.split("?")[0]} failed: ${error.message}`);
			return { error: "ERROR_NETWORK" };
		}
	},

	/**
	 * Find the API key for a module instance without involving the browser.
	 * MagicMirror² identifiers look like "module_3_MMM-FXMacroData", where 3 is
	 * the position in config.modules, so the raw server-side config can be
	 * looked up directly. Values like "${SECRET_FXMACRODATA_API_KEY}" are
	 * already expanded there.
	 * @param {string} identifier Module instance identifier.
	 * @returns {string|null} The API key, or null for keyless access.
	 */
	resolveApiKey (identifier) {
		const modules = global.config && Array.isArray(global.config.modules) ? global.config.modules : [];
		const match = (/^module_(\d+)_/u).exec(identifier || "");
		let entry = match ? modules[Number(match[1])] : null;
		if (!entry || entry.module !== this.name) {
			entry = modules.find((m) => m && m.module === this.name) || null;
		}
		const configured = entry && entry.config && typeof entry.config.apiKey === "string" ? entry.config.apiKey.trim() : "";
		// Ignore placeholders that were never filled in.
		if (configured && !configured.includes("${") && !configured.includes("**SECRET_")) return configured;

		const fromEnv = (process.env.FXMACRODATA_API_KEY || "").trim();
		return fromEnv || null;
	}
});
