// Bun Bake (`bun build --app`) with its built-in React framework: every file in
// pages/ is a route, rendered to static HTML at build time. scripts/finish.ts
// tidies the output and copies public/ afterwards.
export default {
  app: {
    framework: "react",
  },
};
