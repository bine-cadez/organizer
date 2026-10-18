import { createContext, useContext } from "react";
import type { Item, Snapshot, Ticket, ReviewDraft } from "../shared/types";
import type { Command } from "./api";

export type ModalState =
  | { type: "add"; areaId?: string; start?: boolean }
  | { type: "find"; areaId?: string; start?: boolean }
  | {
      type: "book";
      ticket: Ticket;
      date?: string;
      time?: string;
      onStage?: (value: {
        start: string;
        end: string;
        allowOverlap: boolean;
      }) => void;
    }
  | { type: "swap"; item: Item; current: Item }
  | { type: "finish"; item: Item }
  | { type: "edit"; item: Item }
  | { type: "drawer" };
export interface AppContextType {
  state: Snapshot;
  command: Command;
  refresh: () => Promise<Snapshot>;
  busy: boolean;
  navigate: (path: string) => void;
  setModal: (modal: ModalState | null) => void;
  start: (item: Item) => void;
  openItem: (item: Item) => void;
  notify: (message: string) => void;
}
export const AppContext = createContext<AppContextType | null>(null);
export function useApp() {
  const value = useContext(AppContext);
  if (!value) throw new Error("App context missing");
  return value;
}
export const blankDraft = (): ReviewDraft => ({
  completedTicketIds: [],
  slippedDestinations: [],
  bookPages: [],
  markReadBookIds: [],
  learning: null,
});
