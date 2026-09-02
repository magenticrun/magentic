import pkg from "../package.json" with { type: "json" };

/** The CLI's own version, as its package declares it. */
export const VERSION: string = pkg.version;
