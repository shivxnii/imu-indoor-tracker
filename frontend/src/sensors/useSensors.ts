import { useSyncExternalStore } from "react";
import { manager } from "./sensorManager";

export const useSensors = () => useSyncExternalStore(manager.subscribe, manager.getSnapshot);
