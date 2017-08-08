import { Configuration } from '../Configuration';
import { GraphSnapshot } from '../GraphSnapshot';
import { NodeSnapshot } from '../NodeSnapshot';
import { PathPart } from '../primitive';
import { NodeId, Query } from '../schema';
import {
  addNodeReference,
  addToSet,
  expandEdgeArguments,
  hasNodeReference,
  isObject,
  isScalar,
  lazyImmutableDeepSet,
  parameterizedEdgesForOperation,
  removeNodeReference,
  walkPayload,
} from '../util';

/**
 * A newly modified snapshot.
 */
export interface EditedSnapshot {
  snapshot: GraphSnapshot,
  editedNodeIds: Set<NodeId>
}

/**
 * Used when walking payloads to merge.
 */
interface MergeQueueItem {
  containerId: NodeId;
  containerPayload: any;
  visitRoot: boolean;
}

/**
 * Describes an edit to a reference contained within a node.
 */
interface ReferenceEdit {
  /** The node that contains the reference. */
  containerId: NodeId;
  /** The path to the reference within the container. */
  path: PathPart[];
  /** The id of the node that was previously referenced. */
  prevNodeId: NodeId | undefined;
  /** The id of the node that should be referenced. */
  nextNodeId: NodeId | undefined;
}

/**
 * Builds a set of changes to apply on top of an existing `GraphSnapshot`.
 *
 * Performs the minimal set of edits to generate new immutable versions of each
 * node, while preserving immutability of the parent snapshot.
 */
export class SnapshotEditor {

  /**
   * Tracks all node snapshots that have changed vs the parent snapshot.
   */
  private _newNodes = Object.create(null) as { [Key in NodeId]: NodeSnapshot | undefined };

  /**
   * Tracks the nodes that have new _values_ vs the parent snapshot.
   *
   * This is a subset of the keys in `_newValues`.  The difference is all nodes
   * that have only changed references.
   */
  private _editedNodeIds = new Set<NodeId>();

  /**
   * Tracks the nodes that have been rebuilt, and have had all their inbound
   * references updated to point to the new value.
   */
  private _rebuiltNodeIds = new Set<NodeId>();

  constructor(
    /** The configuration to use when editing snapshots. */
    private _config: Configuration,
    /** The snapshot to base edits off of. */
    private _parent: GraphSnapshot,
  ) {}

  /**
   * Merge a GraphQL payload (query/fragment/etc) into the snapshot, rooted at
   * the node identified by `rootId`.
   */
  mergePayload(query: Query, payload: object): void {
    // First, we walk the payload and apply all _scalar_ edits, while collecting
    // all references that have changed.  Reference changes are applied later,
    // once all new nodes have been built (and we can guarantee that we're
    // referencing the correct version).
    const referenceEdits = this._mergePayloadValues(query, payload);

    // Now that we have new versions of every edited node, we can point all the
    // edited references to the correct nodes.
    //
    // In addition, this performs bookkeeping the inboundReferences of affected
    // nodes, and collects all newly orphaned nodes.
    const orphanedNodeIds = this._mergeReferenceEdits(referenceEdits);

    // At this point, every node that has had any of its properties change now
    // exists in _newNodes.  In order to preserve immutability, we need to walk
    // all nodes that transitively reference an edited node, and update their
    // references to point to the new version.
    this._rebuildInboundReferences();

    // Remove (garbage collect) orphaned subgraphs.
    this._removeOrphanedNodes(orphanedNodeIds);
  }

  /**
   * Walk `payload`, and for all changed values (vs the parent), constructs new
   * versions of those nodes, including the new values.
   *
   * All edits are performed on new (shallow) copies of the parent's nodes,
   * preserving their immutability, while copying the minimum number of objects.
   *
   * Note that edited references are only collected, not applied.  They are
   * returned to be applied in a second pass (`_mergeReferenceEdits`), once we
   * can guarantee that all edited nodes have been built.
   */
  private _mergePayloadValues(query: Query, fullPayload: object): ReferenceEdit[] {
    const { entityIdForNode } = this._config;
    const edgeMap = parameterizedEdgesForOperation(query.document);

    const queue = [{ containerId: query.rootId, containerPayload: fullPayload, visitRoot: false }] as MergeQueueItem[];
    const referenceEdits = [] as ReferenceEdit[];

    while (queue.length) {
      const { containerId, containerPayload, visitRoot } = queue.pop() as MergeQueueItem;
      const container = this.get(containerId);

      walkPayload(containerPayload, container, edgeMap, visitRoot, (path, payloadValue, nodeValue, parameterizedEdge) => {
        let nextNodeId = isObject(payloadValue) ? entityIdForNode(payloadValue) : undefined;
        const prevNodeId = isObject(nodeValue) ? entityIdForNode(nodeValue) : undefined;

        if (parameterizedEdge) {
          // swap in any variables.
          const edgeArguments = expandEdgeArguments(parameterizedEdge, query.variables);
          const edgeId = nodeIdForParameterizedValue(containerId, path, edgeArguments);

          // Parameterized edges are references, but maintain their own path.
          const containerSnapshot = this._ensureNewSnapshot(containerId);
          if (!hasNodeReference(containerSnapshot, 'outbound', edgeId)) {
            addNodeReference('outbound', containerSnapshot, edgeId);
            const edgeSnapshot = this._ensureNewSnapshot(edgeId);
            addNodeReference('inbound', edgeSnapshot, containerId);
          }
          // We walk the values of the parameterized edge like any other entity.
          //
          // EXCEPT: We re-visit the payload, in case it might _directly_
          // reference an entity.  This allows us to build a chain of references
          // where the parameterized value points _directly_ to a particular
          // entity node.
          queue.push({ containerId: edgeId, containerPayload: payloadValue, visitRoot: true });

          // Stop the walk for this subgraph.
          return true;

        // We've hit a reference.
        } else if (prevNodeId || nextNodeId) {
          // If we already know there is a node at this location, we can merge
          // with it if no new identity was provided.
          //
          // TODO: Is this too forgiving?
          if (!nextNodeId && payloadValue) {
            nextNodeId = prevNodeId;
          }

          // The payload is now referencing a new entity.  We want to update it,
          // but not until we've updated the values of our entities first.
          if (prevNodeId !== nextNodeId) {
            referenceEdits.push({ containerId, path: [...path], prevNodeId, nextNodeId });
          }

          // Either we have a new value to merge, or we're clearing a reference.
          // In both cases, _mergeReferenceEdits will take care of setting the
          // value at this path.
          //
          // So, walk if we have new values, otherwise we're done for this
          // subgraph.
          if (nextNodeId) {
            queue.push({ containerId: nextNodeId, containerPayload: payloadValue, visitRoot: false });
          }
          // Stop the walk for this subgraph.
          return true;

        // Arrays are a little special.  When present, we assume that the values
        // contained within the array are the _full_ set of values.
        } else if (Array.isArray(payloadValue)) {
          // We will walk to each value within the array, so we do not need to
          // process them yet; but because we update them by path, we do need to
          // ensure that the updated entity's array has the same number of
          // values.
          if (nodeValue && nodeValue.length === payloadValue.length) return false;

          const newArray = Array.isArray(nodeValue) ? nodeValue.slice(0, payloadValue.length) : [];
          this._setValue(containerId, path, newArray);

        // All else we care about are updated scalar values.
        } else if (isScalar(payloadValue) && payloadValue !== nodeValue) {
          this._setValue(containerId, path, payloadValue);
        }

        return false;
      });
    }

    return referenceEdits;
  }

  /**
   * Update all nodes with edited references, and ensure that the bookkeeping of
   * the new and _past_ references are properly updated.
   *
   * Returns the set of node ids that are newly orphaned by these edits.
   */
  private _mergeReferenceEdits(referenceEdits: ReferenceEdit[]): Set<NodeId> {
    const orphanedNodeIds = new Set() as Set<NodeId>;

    for (const { containerId, path, prevNodeId, nextNodeId } of referenceEdits) {
      const target = nextNodeId ? this.get(nextNodeId) : null;
      this._setValue(containerId, path, target);
      const container = this._ensureNewSnapshot(containerId);

      if (prevNodeId) {
        removeNodeReference('outbound', container, prevNodeId, path);
        const prevTarget = this._ensureNewSnapshot(prevNodeId);
        removeNodeReference('inbound', prevTarget, containerId, path);
        if (!prevTarget.inbound) {
          orphanedNodeIds.add(prevNodeId);
        }
      }

      if (nextNodeId) {
        addNodeReference('outbound', container, nextNodeId, path);
        const nextTarget = this._ensureNewSnapshot(nextNodeId);
        addNodeReference('inbound', nextTarget, containerId, path);
        orphanedNodeIds.delete(nextNodeId);
      }
    }

    return orphanedNodeIds;
  }

  /**
   * Transitively walks the inbound references of all edited nodes, rewriting
   * those references to point to the newly edited versions.
   */
  private _rebuildInboundReferences(): void {
    const queue = Array.from(this._editedNodeIds);
    addToSet(this._rebuiltNodeIds, queue);

    while (queue.length) {
      const nodeId = queue.pop() as NodeId;
      const snapshot = this.getSnapshot(nodeId);
      if (!snapshot || !snapshot.inbound) continue;

      for (const { id, path } of snapshot.inbound) {
        if (!path) continue;
        this._setValue(id, path, snapshot.node, false);
        if (this._rebuiltNodeIds.has(id)) continue;

        this._rebuiltNodeIds.add(id);
        queue.push(id);
      }
    }
  }

  /**
   * Transitively removes all orphaned nodes from the graph.
   */
  private _removeOrphanedNodes(nodeIds: Set<NodeId>): void {
    const queue = Array.from(nodeIds);
    while (queue.length) {
      const nodeId = queue.pop() as NodeId;
      const node = this.getSnapshot(nodeId);
      if (!node) continue;

      this._newNodes[nodeId] = undefined;
      this._editedNodeIds.add(nodeId);

      if (!node.outbound) continue;
      for (const { id, path } of node.outbound) {
        const reference = this._ensureNewSnapshot(id);
        if (removeNodeReference('inbound', reference, nodeId, path)) {
          queue.push(id);
        }
      }
    }
  }

  /**
   * Commits the transaction, returning a new immutable snapshot.
   */
  commit(): EditedSnapshot {
    const snapshots: { [Key in NodeId]: NodeSnapshot } = { ...(this._parent as any)._values };
    for (const id in this._newNodes) {
      const newSnapshot = this._newNodes[id];
      // Drop snapshots that were garbage collected.
      if (newSnapshot === undefined) {
        delete snapshots[id];
      } else {
        snapshots[id] = newSnapshot;
      }
    }

    return {
      snapshot: new GraphSnapshot(snapshots),
      editedNodeIds: this._editedNodeIds,
    };
  }

  /**
   * Retrieve the _latest_ version of a node.
   */
  private get(id: NodeId) {
    const snapshot = this.getSnapshot(id);
    return snapshot ? snapshot.node : undefined;
  }

  /**
   * Retrieve the _latest_ version of a node snapshot.
   */
  private getSnapshot(id: NodeId) {
    return id in this._newNodes ? this._newNodes[id] : this._parent.getSnapshot(id);
  }

  /**
   * Set `newValue` at `path` of the value snapshot identified by `id`, without
   * modifying the parent's copy of it.
   *
   * This will not shallow clone objects/arrays along `path` if they were
   * previously cloned during this transaction.
   */
  private _setValue(id: NodeId, path: PathPart[], newValue: any, isEdit = true) {
    if (isEdit) {
      this._editedNodeIds.add(id);
    }

    const parent = this._parent.getSnapshot(id);
    const current = this._ensureNewSnapshot(id);
    (current as any).node = lazyImmutableDeepSet(current && current.node, parent && parent.node, path, newValue);
  }

  /**
   * TODO: Support more than just entity snapshots.
   */
  private _ensureNewSnapshot(id: NodeId, initialValue?: object): NodeSnapshot {
    let newSnapshot;
    if (id in this._newNodes) {
      const current = this._newNodes[id];
      // We may have deleted the node.
      if (current) return current;
      // If so, we should start fresh.
      newSnapshot = new NodeSnapshot();
    } else {
      const parent = this._parent.getSnapshot(id);
      const value = parent ? { ...parent.node } : {};
      const inbound = parent && parent.inbound ? [...parent.inbound] : undefined;
      const outbound = parent && parent.outbound ? [...parent.outbound] : undefined;

      newSnapshot = new NodeSnapshot(value, inbound, outbound);
    }

    this._newNodes[id] = newSnapshot;
    return newSnapshot;
  }

}

/**
 * Generate a stable id for a parameterized value.
 */
export function nodeIdForParameterizedValue(containerId: NodeId, path: PathPart[], args: object) {
  return `${containerId}❖${JSON.stringify(path)}❖${JSON.stringify(args)}`;
}