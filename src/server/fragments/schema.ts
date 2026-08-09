/**
 * Compatibility façade for the original server-local contract path.
 *
 * Story domain contracts are isomorphic and canonical in `src/contracts` so
 * server and client code can share them without maintaining parallel shapes.
 */
export * from '../../contracts/story'

// Compatibility names for code that imported the original persisted-chain
// contract from this server-local module.
export {
  StoredProseChainEntrySchema as ProseChainEntrySchema,
  StoredProseChainSchema as ProseChainSchema,
} from '../../contracts/story'
export type {
  StoredProseChainEntry as ProseChainEntry,
  StoredProseChain as ProseChain,
} from '../../contracts/story'
