import { createContext, useContext } from 'react';

/**
 * Whether the research pages show technical details: node IDs, file paths,
 * and the agent's own wording of its last step. Off by default; a display
 * preference in Settings, kept per user with the rest of the UI state.
 */
export const TechnicalDetails = createContext(false);

export const useTechnical = () => useContext(TechnicalDetails);
