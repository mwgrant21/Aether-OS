// Variant selection for the renderer window: the GUI shell is opt-in at launch.
export const guiVariantEnabled = (env: NodeJS.ProcessEnv): boolean => env.AETHER_GUI === '1';

export const rendererEntryName = (env: NodeJS.ProcessEnv): 'gui.html' | 'index.html' =>
  guiVariantEnabled(env) ? 'gui.html' : 'index.html';
