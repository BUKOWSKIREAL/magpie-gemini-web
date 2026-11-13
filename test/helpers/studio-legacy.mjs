// Historical installation fixtures, independent of the runtime's official release resolver.
import release from '../../lib/studio-release.json' with { type: 'json' };
export const STUDIO_VERSION = `v${release.version}`;
export const PINNED_ARCHIVES = release.binaries;
export const CAMOUFOX_VERSION = release.upstream.camoufox;
