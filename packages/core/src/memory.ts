import logger from "./logger.ts";
import {
    ModelClass,
    type IAgentRuntime,
    type IMemoryManager,
    type Memory,
    type UUID,
    type KnowledgeMetadata,
    type MemoryType,
} from "./types.ts";

const defaultMatchThreshold = 0.1;
const defaultMatchCount = 10;

/**
 * Manage memories in the database.
 */
export class MemoryManager implements IMemoryManager {
    /**
     * The AgentRuntime instance associated with this manager.
     */
    runtime: IAgentRuntime;

    /**
     * The name of the database table this manager operates on.
     */
    tableName: string;

    /**
     * Constructs a new MemoryManager instance.
     * @param opts Options for the manager.
     * @param opts.tableName The name of the table this manager will operate on.
     * @param opts.runtime The AgentRuntime instance associated with this manager.
     */
    constructor(opts: { tableName: string; runtime: IAgentRuntime }) {
        this.runtime = opts.runtime;
        this.tableName = opts.tableName;
    }

    private validateMetadata(metadata: KnowledgeMetadata): void {
        // Validate type is present and valid
        if (!metadata.type || !["document", "fragment", "message", "fact"].includes(metadata.type)) {
            throw new Error('Invalid memory type');
        }

        // Validate sourceId if present
        if (metadata.sourceId && typeof metadata.sourceId !== 'string') {
            throw new Error('Metadata sourceId must be a UUID string');
        }

        // Validate chunkIndex if present
        if (metadata.chunkIndex !== undefined && typeof metadata.chunkIndex !== 'number') {
            throw new Error('Metadata chunkIndex must be a number');
        }

        // Validate source if present
        if (metadata.source && typeof metadata.source !== 'string') {
            throw new Error('Metadata source must be a string');
        }

        // Validate scope if present
        if (metadata.scope && !['shared', 'private', 'room'].includes(metadata.scope)) {
            throw new Error('Metadata scope must be "shared", "private", or "room"');
        }

        // Validate tags if present
        if (metadata.tags && !Array.isArray(metadata.tags)) {
            throw new Error('Metadata tags must be an array of strings');
        }
    }

    /**
     * Adds an embedding vector to a memory object. If the memory already has an embedding, it is returned as is.
     * @param memory The memory object to add an embedding to.
     * @returns A Promise resolving to the memory object, potentially updated with an embedding vector.
     */
    /**
     * Adds an embedding vector to a memory object if one doesn't already exist.
     * The embedding is generated from the memory's text content using the runtime's
     * embedding model. If the memory has no text content, an error is thrown.
     *
     * @param memory The memory object to add an embedding to
     * @returns The memory object with an embedding vector added
     * @throws Error if the memory content is empty
     */
    async addEmbeddingToMemory(memory: Memory): Promise<Memory> {
        // Return early if embedding already exists
        if (memory.embedding) {
            return memory;
        }

        const memoryText = memory.content.text;

        // Validate memory has text content
        if (!memoryText) {
            throw new Error(
                "Cannot generate embedding: Memory content is empty"
            );
        }

        try {
            // Generate embedding from text content
            memory.embedding = await this.runtime.useModel(ModelClass.TEXT_EMBEDDING, memoryText);
        } catch (error) {
            logger.error("Failed to generate embedding:", error);
            // Fallback to zero vector if embedding fails
            memory.embedding = await this.runtime.useModel(ModelClass.TEXT_EMBEDDING, null);
        }

        return memory;
    }

    /**
     * Retrieves a list of memories by user IDs, with optional deduplication.
     * @param opts Options including user IDs, count, and uniqueness.
     * @param opts.roomId The room ID to retrieve memories for.
     * @param opts.count The number of memories to retrieve.
     * @param opts.unique Whether to retrieve unique memories only.
     * @returns A Promise resolving to an array of Memory objects.
     */
    async getMemories(opts: {
        roomId: UUID;
        count?: number;
        unique?: boolean;
        start?: number;
        end?: number;
        agentId?: UUID;
    }): Promise<Memory[]> {
        return await this.runtime.databaseAdapter.getMemories({
            roomId: opts.roomId,
            count: opts.count,
            unique: opts.unique,
            tableName: this.tableName,
            agentId: opts.agentId,
            start: opts.start,
            end: opts.end,
        });
    }

    async getCachedEmbeddings(content: string): Promise<
        {
            embedding: number[];
            levenshtein_score: number;
        }[]
    > {
        return await this.runtime.databaseAdapter.getCachedEmbeddings({
            query_table_name: this.tableName,
            query_threshold: 2,
            query_input: content,
            query_field_name: "content",
            query_field_sub_name: "text",
            query_match_count: 10,
        });
    }

    /**
     * Searches for memories similar to a given embedding vector.
     * @param embedding The embedding vector to search with.
     * @param opts Options including match threshold, count, user IDs, and uniqueness.
     * @param opts.match_threshold The similarity threshold for matching memories.
     * @param opts.count The maximum number of memories to retrieve.
     * @param opts.roomId The room ID to retrieve memories for.
     * @param opts.unique Whether to retrieve unique memories only.
     * @returns A Promise resolving to an array of Memory objects that match the embedding.
     */
    async searchMemories(
        opts: {
            embedding: number[],
            match_threshold?: number;
            count?: number;
            roomId: UUID;
            agentId?: UUID;
            unique?: boolean;
        }
    ): Promise<Memory[]> {
        const {
            match_threshold = defaultMatchThreshold,
            embedding,
            count = defaultMatchCount,
            roomId,
            agentId,
            unique = true,
        } = opts;

        return await this.runtime.databaseAdapter.searchMemories({
            tableName: this.tableName,
            roomId,
            agentId,
            embedding,
            match_threshold,
            count,
            unique,
        });
    }

    /**
     * Creates a new memory in the database, with an option to check for similarity before insertion.
     * @param memory The memory object to create.
     * @param unique Whether to check for similarity before insertion.
     * @returns A Promise that resolves when the operation completes.
     */
    async createMemory(memory: Memory, unique = false): Promise<void> {
        const existingMessage = await this.runtime.databaseAdapter.getMemoryById(memory.id);

        if (existingMessage) {
            logger.debug("Memory already exists, skipping");
            return;
        }

        // Initialize metadata for knowledge-type memories
        if (!memory.content.metadata) {
            memory.content.metadata = {
                type: this.tableName === 'knowledge' ? 'document' : 'message', // Default type based on context
                source: this.tableName,
                scope: memory.agentId ? 'private' : 'shared',
                timestamp: Date.now()
            };
        }

        // Handle metadata if present
        if (memory.content.metadata) {
            // Validate metadata
            this.validateMetadata(memory.content.metadata);

            // Ensure timestamp
            if (!memory.content.metadata.timestamp) {
                memory.content.metadata.timestamp = Date.now();
            }

            // Set default scope if not present
            if (!memory.content.metadata.scope) {
                memory.content.metadata.scope = memory.agentId ? 'private' : 'shared';
            }

            // Set source if not present
            if (!memory.content.metadata.source) {
                memory.content.metadata.source = this.tableName;
            }
        }

        logger.log("Creating Memory", memory.id, memory.content.text);

        if (!memory.embedding) {
            memory.embedding = await this.runtime.useModel(ModelClass.TEXT_EMBEDDING, null);
        }

        await this.runtime.databaseAdapter.createMemory(
            memory,
            this.getTableNameForType(memory.content.metadata.type),
            unique
        );
    }

    /**
     * Maps memory types to table names
     */
    private getTableNameForType(type: MemoryType): string {
        switch (type) {
            case 'document':
            case 'fragment':
                return 'knowledge';
            case 'message':
                return 'messages';
            case 'fact':
                return 'facts';
            default:
                return this.tableName; // Fallback to instance table name
        }
    }

    async getMemoriesByRoomIds(params: { roomIds: UUID[], limit?: number; agentId?: UUID }): Promise<Memory[]> {
        return await this.runtime.databaseAdapter.getMemoriesByRoomIds({
            tableName: this.tableName,
            agentId: params.agentId,
            roomIds: params.roomIds,
            limit: params.limit
        });
    }

    async getMemoryById(id: UUID): Promise<Memory | null> {
        const result = await this.runtime.databaseAdapter.getMemoryById(id);
        if (result && result.agentId !== this.runtime.agentId) return null;
        return result;
    }

    /**
     * Removes a memory from the database by its ID.
     * @param memoryId The ID of the memory to remove.
     * @returns A Promise that resolves when the operation completes.
     */
    async removeMemory(memoryId: UUID): Promise<void> {
        await this.runtime.databaseAdapter.removeMemory(
            memoryId,
            this.tableName
        );
    }

    /**
     * Removes all memories associated with a set of user IDs.
     * @param roomId The room ID to remove memories for.
     * @returns A Promise that resolves when the operation completes.
     */
    async removeAllMemories(roomId: UUID): Promise<void> {
        await this.runtime.databaseAdapter.removeAllMemories(
            roomId,
            this.tableName
        );
    }

    /**
     * Counts the number of memories associated with a set of user IDs, with an option for uniqueness.
     * @param roomId The room ID to count memories for.
     * @param unique Whether to count unique memories only.
     * @returns A Promise resolving to the count of memories.
     */
    async countMemories(roomId: UUID, unique = true): Promise<number> {
        return await this.runtime.databaseAdapter.countMemories(
            roomId,
            unique,
            this.tableName
        );
    }
}
