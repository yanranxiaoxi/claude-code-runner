import type { SandboxConfig } from './types';

/**
 * Returns true when an image reference already contains an explicit tag or
 * digest. A registry port (e.g. localhost:5000/project) is not a tag.
 */
export function hasExplicitImageTag(image: string): boolean {
	if (image.includes('@')) {
		return true;
	}

	const lastSlash = image.lastIndexOf('/');
	const lastColon = image.lastIndexOf(':');
	return lastColon > lastSlash;
}

/**
 * Strip an image tag or digest and return the repository name. Registry ports
 * (e.g. localhost:5000/project) are preserved.
 */
export function getImageBaseName(image: string): string {
	const digestIndex = image.indexOf('@');
	if (digestIndex !== -1) {
		return image.slice(0, digestIndex);
	}

	const lastSlash = image.lastIndexOf('/');
	const lastColon = image.lastIndexOf(':');
	return lastColon > lastSlash ? image.slice(0, lastColon) : image;
}

/**
 * Resolve the image reference used for both pulling/building and container
 * creation. Keeping this in one place prevents the pulled tag and the container
 * image tag from diverging.
 */
export function resolveDockerImage(
	config: Pick<SandboxConfig, 'buildImage' | 'dockerImage' | 'useNightlyImage'>,
): string {
	let image = config.dockerImage || 'claude-code-runner';

	if (hasExplicitImageTag(image)) {
		return image;
	}

	if (config.buildImage === false) {
		image += config.useNightlyImage ? ':nightly' : ':v__PACKAGE_VERSION__';
	}
	else {
		image += ':latest';
	}

	return image;
}
