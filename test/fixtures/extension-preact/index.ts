// A test-only tool package whose browser entry is a Preact bundle (browser/), to prove a framework
// can meet the host's frontend contract under the page's unchanged CSP. Never installed, enabled or
// copied into the image: test/browser/fixture.test.mjs loads it through loadPackages' hooks.
import { defineToolPackage } from "@paca/extension";

export default defineToolPackage({
	name: "preact-fixture",
	browser: {
		dir: new URL("./browser/", import.meta.url).href,
		entry: "dist/index.js",
		styles: ["fixture.css"],
		cards: ["counter"],
		pages: { demo: { title: "Fixture" } },
		nav: { label: "Fixture", page: "demo" },
	},
	forUser: () => ({
		tools: [],
		labels: {},
		scope: { label: "Fixture", detail: "test only" },
		operations: { echo: async (input) => ({ echo: input as Record<string, string>, from: "preact-fixture" }) },
	}),
});
