/* global Module Log config FXMacroDataHelpers */

/*
 * MMM-FXMacroData
 *
 * Shows the upcoming macroeconomic release calendar for a set of currencies,
 * with a countdown to the next release and an optional table of the latest
 * values for a few indicators. Data comes from the FXMacroData API, fetched
 * by node_helper.js on the server.
 *
 * MIT Licensed.
 */
Module.register("MMM-FXMacroData", {
	defaults: {
		currencies: ["USD"],
		maxItems: 6,
		minImportance: "medium", // "low", "medium" or "high"
		lookaheadDays: 14,
		showCountdown: true,
		showCurrency: true,
		showReferencePeriod: false,
		showLatest: true,
		indicators: ["inflation", "policy_rate", "unemployment"],
		showFooter: true,
		apiKey: "", // read by the node helper only; see README for keeping it out of the browser
		updateInterval: 15 * 60 * 1000,
		animationSpeed: 1000
	},

	requiresVersion: "2.20.0",

	getScripts () {
		return [this.file("fxmd_data.js")];
	},

	getStyles () {
		return ["font-awesome.css", this.file("MMM-FXMacroData.css")];
	},

	getTranslations () {
		return {
			en: "translations/en.json"
		};
	},

	start () {
		Log.info(`Starting module: ${this.name}`);
		this.payload = null;
		this.loaded = false;

		// Only the display settings go over the socket. The API key stays in
		// the server-side config and is picked up there by the node helper.
		this.sendSocketNotification("FXMD_START", {
			identifier: this.identifier,
			currencies: this.config.currencies,
			indicators: this.config.indicators,
			showLatest: this.config.showLatest,
			minImportance: this.config.minImportance,
			lookaheadDays: this.config.lookaheadDays,
			maxItems: this.config.maxItems,
			updateInterval: this.config.updateInterval
		});

		// Keep the countdown and "past" releases current between fetches.
		this.tickTimer = setInterval(() => {
			if (this.loaded) this.updateDom();
		}, 60 * 1000);
	},

	socketNotificationReceived (notification, payload) {
		if (notification !== "FXMD_DATA" || !payload || payload.identifier !== this.identifier) return;
		this.payload = payload;
		this.loaded = true;
		this.updateDom(this.config.animationSpeed);
	},

	getDom () {
		const wrapper = document.createElement("div");
		wrapper.className = "fxmd";

		if (!this.loaded) {
			wrapper.classList.add("dimmed", "light", "small");
			wrapper.textContent = this.translate("LOADING");
			return wrapper;
		}

		const now = Date.now();
		const releases = this.payload.releases.filter((release) => release.time > now);

		if (this.config.showCountdown && releases.length > 0) {
			wrapper.appendChild(this.renderNext(releases[0], now));
		}

		if (releases.length > 0) {
			wrapper.appendChild(this.renderCalendar(releases));
		} else if (this.payload.errors.length === 0) {
			const empty = document.createElement("div");
			empty.className = "dimmed light small";
			empty.textContent = this.translate("NO_RELEASES");
			wrapper.appendChild(empty);
		}

		if (this.config.showLatest && this.payload.latest.length > 0) {
			wrapper.appendChild(this.renderLatest(this.payload.latest));
		}

		for (const error of this.payload.errors) {
			const message = document.createElement("div");
			message.className = "fxmd-error xsmall";
			message.textContent = this.translate(error.key, { currency: error.currency });
			wrapper.appendChild(message);
		}

		if (this.config.showFooter) {
			const footer = document.createElement("div");
			footer.className = "fxmd-footer xsmall dimmed";
			footer.textContent = this.payload.hasApiKey ? this.translate("FOOTER") : this.translate("FOOTER_DELAYED");
			wrapper.appendChild(footer);
		}

		return wrapper;
	},

	renderNext (release, now) {
		const next = document.createElement("div");
		next.className = `fxmd-next small importance-${release.importance}`;

		const label = document.createElement("span");
		label.className = "dimmed";
		label.textContent = `${this.translate("NEXT")} `;
		next.appendChild(label);

		const name = document.createElement("span");
		name.className = "bright";
		name.textContent = this.config.showCurrency ? `${release.currency} ${release.name}` : release.name;
		next.appendChild(name);

		const countdown = document.createElement("span");
		countdown.className = "fxmd-countdown";
		countdown.textContent = ` ${this.translate("IN")} ${FXMacroDataHelpers.formatCountdown(release.time - now)}`;
		next.appendChild(countdown);

		return next;
	},

	renderCalendar (releases) {
		const table = document.createElement("table");
		table.className = "fxmd-calendar small";

		for (const release of releases) {
			const row = document.createElement("tr");
			row.className = `importance-${release.importance}`;

			const marker = document.createElement("td");
			marker.className = "fxmd-marker";
			const dot = document.createElement("span");
			dot.className = "fxmd-dot";
			dot.title = this.translate(`IMPORTANCE_${release.importance.toUpperCase()}`);
			marker.appendChild(dot);
			row.appendChild(marker);

			if (this.config.showCurrency) {
				const currency = document.createElement("td");
				currency.className = "fxmd-currency";
				currency.textContent = release.currency;
				row.appendChild(currency);
			}

			const name = document.createElement("td");
			name.className = "fxmd-name";
			name.textContent = release.name;
			if (this.config.showReferencePeriod && release.referencePeriod) {
				const period = document.createElement("span");
				period.className = "fxmd-period dimmed";
				period.textContent = ` ${release.referencePeriod}`;
				name.appendChild(period);
			}
			row.appendChild(name);

			const time = document.createElement("td");
			time.className = "fxmd-time";
			time.textContent = this.formatReleaseTime(release.time);
			row.appendChild(time);

			table.appendChild(row);
		}
		return table;
	},

	renderLatest (items) {
		const table = document.createElement("table");
		table.className = "fxmd-latest xsmall";

		const head = document.createElement("tr");
		head.className = "dimmed";
		for (const key of ["", "LATEST", "PREVIOUS"]) {
			const cell = document.createElement("th");
			cell.textContent = key ? this.translate(key) : "";
			head.appendChild(cell);
		}
		table.appendChild(head);

		const locale = config.language;
		for (const item of items) {
			const row = document.createElement("tr");

			const name = document.createElement("td");
			name.className = "fxmd-name";
			name.textContent = this.config.showCurrency ? `${item.currency} ${item.name}` : item.name;
			row.appendChild(name);

			const value = document.createElement("td");
			value.className = "fxmd-value bright";
			if (item.value === null && item.outsideFreeWindow) {
				value.classList.add("dimmed");
				value.textContent = this.translate("NEEDS_KEY");
			} else {
				value.textContent = FXMacroDataHelpers.formatValue(item.value, item.unit, locale);
				if (typeof item.change === "number" && item.change !== 0) {
					const arrow = document.createElement("i");
					arrow.className = item.change > 0 ? "fa-solid fa-caret-up fxmd-up" : "fa-solid fa-caret-down fxmd-down";
					value.appendChild(arrow);
				}
			}
			row.appendChild(value);

			const previous = document.createElement("td");
			previous.className = "fxmd-previous dimmed";
			previous.textContent = FXMacroDataHelpers.formatValue(item.previous, item.unit, locale);
			row.appendChild(previous);

			table.appendChild(row);
		}
		return table;
	},

	formatReleaseTime (time) {
		const options = {
			weekday: "short",
			day: "numeric",
			month: "short",
			hour: "2-digit",
			minute: "2-digit",
			hour12: config.timeFormat === 12
		};
		try {
			return new Intl.DateTimeFormat(config.language, options).format(new Date(time));
		} catch {
			return new Date(time).toLocaleString();
		}
	}
});
