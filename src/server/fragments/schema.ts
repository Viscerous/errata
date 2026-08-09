/**
 * Compatibility façade for the original server-local contract path.
 *
 * Story domain contracts are isomorphic and canonical in `src/contracts` so
 * server and client code can share them without maintaining parallel shapes.
 */
export * from '../../contracts/story'
