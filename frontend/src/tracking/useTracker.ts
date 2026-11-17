import { useSyncExternalStore } from "react";
import { tracker } from "./tracker";

export const useTracker = () => useSyncExternalStore(tracker.subscribe, tracker.getSnapshot);
