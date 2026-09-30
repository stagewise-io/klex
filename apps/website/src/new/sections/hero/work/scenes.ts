import type { ComponentType } from 'react';

import type { WorkApp } from './window';

export type WorkSceneProps = {
  variant: number;
  setApp: (app: WorkApp) => void;
  onDone: () => void;
};

export type WorkScene = {
  /** How many variants the scene can play. */
  count: number;
  app: (variant: number) => WorkApp;
  Scene: ComponentType<WorkSceneProps>;
};
