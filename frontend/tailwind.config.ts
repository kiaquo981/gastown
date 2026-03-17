import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'SF Mono', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
};

export default config;
