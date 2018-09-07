import * as agent from "@prague/agent";
import * as api from "@prague/client-api";
import { IDocumentMessage, ITokenClaims, ITrace } from "@prague/runtime-definitions";
import * as socketStorage from "@prague/socket-storage";
import * as jwt from "jsonwebtoken";
import * as winston from "winston";
import * as core from "../core";

export function register(
    webSocketServer: core.IWebSocketServer,
    metricClientConfig: any,
    orderManager: core.IOrdererManager,
    tenantManager: core.ITenantManager) {

    const metricLogger = agent.createMetricClient(metricClientConfig);

    webSocketServer.on("connection", (socket: core.IWebSocket) => {
        // Map from client IDs on this connection to the object ID and user info.
        const connectionsMap = new Map<string, core.IOrdererConnection>();

        async function connectDocument(message: socketStorage.IConnect): Promise<socketStorage.IConnected> {
            if (!message.token) {
                return Promise.reject("Must provide an authorization token");
            }

            // Validate token signature and claims
            const token = message.token;
            const claims = jwt.decode(token) as ITokenClaims;
            if (claims.documentId !== message.id || claims.tenantId !== message.tenantId) {
                return Promise.reject("Invalid claims");
            }
            await tenantManager.verifyToken(claims.tenantId, token);

            // And then connect to the orderer
            const orderer = await orderManager.getOrderer(claims.tenantId, claims.documentId);
            const connection = await orderer.connect(socket, claims.user, message.client);
            connectionsMap.set(connection.clientId, connection);

            // And return the connection information to the client
            const connectedMessage: socketStorage.IConnected = {
                clientId: connection.clientId,
                existing: connection.existing,
                parentBranch: connection.parentBranch,
                user: claims.user,
            };

            return connectedMessage;
        }

        // todo: remove this handler once clients onboard "connect_document"
        // Note connect is a reserved socket.io word so we use connectDocument to represent the connect request
        socket.on("connectDocument", async (message: socketStorage.IConnect, response) => {
            connectDocument(message).then(
                (connectedMessage) => {
                    response(null, connectedMessage);
                },
                (error) => {
                    winston.info(`connectDocument error`, error);
                    response(error, null);
                });
        });

        // Note connect is a reserved socket.io word so we use connect_document to represent the connect request
        socket.on("connect_document", async (message: socketStorage.IConnect) => {
            connectDocument(message).then(
                (connectedMessage) => {
                    socket.emit("connect_document_success", connectedMessage);
                },
                (error) => {
                    winston.info(`connectDocument error`, error);
                    socket.emit("connect_document_error", error);
                });
        });

        // Message sent when a new operation is submitted to the router
        socket.on("submitOp", (clientId: string, messages: IDocumentMessage[], response) => {
            // Verify the user has connected on this object id
            if (!connectionsMap.has(clientId)) {
                return response("Invalid client ID", null);
            }

            for (const message of messages) {
                if (message.type === api.RoundTrip) {
                    // End of tracking. Write traces.
                    const messageWithTraces = message as IDocumentMessage & { traces?: ITrace[] };
                    if (messageWithTraces.traces !== undefined) {
                        metricLogger.writeLatencyMetric("latency", messageWithTraces.traces).catch(
                            (error) => {
                                winston.error(error.stack);
                            });
                    }
                } else {
                    const connection = connectionsMap.get(clientId);
                    connection.order(message);
                }
            }

            response(null);
        });

        socket.on("disconnect", () => {
            // Send notification messages for all client IDs in the connection map
            for (const [clientId, connection] of connectionsMap) {
                winston.info(`Disconnect of ${clientId}`);
                connection.disconnect();
            }
        });
    });
}
