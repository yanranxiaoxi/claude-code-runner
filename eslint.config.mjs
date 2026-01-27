import antfu from '@antfu/eslint-config';

export default antfu(
	{
		stylistic: {
			indent: 'tab',
			quotes: 'single',
			semi: true,
		},

		typescript: true,

		ignores: [
			'/dist/',
			'/node_modules/',
			'.eslintcache',
			'debug.log',
			'/docs/**',
			'**/*.md',
		],

		rules: {
			'no-console': 'off',
			'unused-imports/no-unused-vars': 'off',
			'no-unused-vars': 'off',
			'no-alert': 'off',
		},
	},
);
