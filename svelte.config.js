import adapterAuto from '@sveltejs/adapter-auto';

let adapter = adapterAuto;
try {
	adapter = (await import('@sveltejs/adapter-node')).default;
} catch {}

/** @type {import('@sveltejs/kit').Config} */
const config = {
	kit: {
		adapter: adapter()
	}
};

export default config;
