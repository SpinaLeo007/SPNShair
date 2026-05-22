const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3001;

const app = express();

app.use(
    cors({
        origin: "*",
        methods: ["GET", "POST"]
    })
);

app.use(express.json());

app.get("/", (req, res) => {
    res.status(200).send("SPNShare signaling server is running.");
});

app.get("/health", (req, res) => {
    res.status(200).json({
        ok: true,
        service: "SPNShare",
        message: "Server online",
        activeSessions: sessions.size
    });
});

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    transports: ["websocket", "polling"],
    pingInterval: 25000,
    pingTimeout: 60000
});

const sessions = new Map();

function generateSessionCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function safeEmit(socketId, eventName, data) {
    if (!socketId) {
        return;
    }

    io.to(socketId).emit(eventName, data);
}

function deleteViewerFromSession(code) {
    const session = sessions.get(code);

    if (!session) {
        return;
    }

    session.viewerSocketId = null;
    session.accepted = false;
}

function closeSession(code, socketId) {
    const session = sessions.get(code);

    if (!session) {
        return;
    }

    io.to(code).emit("session:closed", {
        message: "The session has been closed."
    });

    if (session.hostSocketId === socketId) {
        sessions.delete(code);
        console.log(`[SPNShare] Session ${code} deleted because host disconnected`);
        return;
    }

    if (session.viewerSocketId === socketId) {
        deleteViewerFromSession(code);
        console.log(`[SPNShare] Viewer removed from session ${code}`);
    }
}

io.on("connection", (socket) => {
    console.log("[SPNShare] Connected:", socket.id);

    socket.emit("server:hello", {
        ok: true,
        message: "Connected to SPNShare server.",
        socketId: socket.id
    });

    socket.on("host:create", () => {
        let code = generateSessionCode();

        while (sessions.has(code)) {
            code = generateSessionCode();
        }

        sessions.set(code, {
            hostSocketId: socket.id,
            viewerSocketId: null,
            accepted: false,
            createdAt: Date.now()
        });

        socket.join(code);
        socket.data.sessionCode = code;
        socket.data.role = "host";

        socket.emit("host:created", {
            code
        });

        console.log(`[SPNShare] Host created session ${code}`);
    });

    socket.on("viewer:join", ({ code }) => {
        code = String(code || "").trim();

        if (!/^\d{6}$/.test(code)) {
            socket.emit("viewer:error", {
                message: "Invalid session code."
            });
            return;
        }

        if (!sessions.has(code)) {
            socket.emit("viewer:error", {
                message: "Session not found."
            });
            return;
        }

        const session = sessions.get(code);

        if (!session.hostSocketId) {
            socket.emit("viewer:error", {
                message: "Host is not available."
            });
            return;
        }

        if (session.viewerSocketId && session.viewerSocketId !== socket.id) {
            socket.emit("viewer:error", {
                message: "This session already has a viewer connected."
            });
            return;
        }

        session.viewerSocketId = socket.id;
        session.accepted = false;

        socket.join(code);
        socket.data.sessionCode = code;
        socket.data.role = "viewer";

        safeEmit(session.hostSocketId, "host:connection-request", {
            viewerSocketId: socket.id,
            code
        });

        socket.emit("viewer:waiting", {
            message: "Waiting for the remote PC to accept..."
        });

        console.log(`[SPNShare] Viewer requested session ${code}`);
    });

    socket.on("host:accept", ({ code }) => {
        code = String(code || "").trim();

        const session = sessions.get(code);

        if (!session) {
            socket.emit("host:error", {
                message: "Session not found."
            });
            return;
        }

        if (session.hostSocketId !== socket.id) {
            socket.emit("host:error", {
                message: "You are not the host of this session."
            });
            return;
        }

        if (!session.viewerSocketId) {
            socket.emit("host:error", {
                message: "No viewer is waiting."
            });
            return;
        }

        session.accepted = true;

        safeEmit(session.viewerSocketId, "viewer:accepted", {
            code
        });

        safeEmit(session.hostSocketId, "host:accepted", {
            code
        });

        console.log(`[SPNShare] Session ${code} accepted`);
    });

    socket.on("host:reject", ({ code }) => {
        code = String(code || "").trim();

        const session = sessions.get(code);

        if (!session) {
            return;
        }

        if (session.hostSocketId !== socket.id) {
            return;
        }

        if (!session.viewerSocketId) {
            return;
        }

        safeEmit(session.viewerSocketId, "viewer:rejected", {
            message: "The remote PC rejected the connection."
        });

        deleteViewerFromSession(code);

        console.log(`[SPNShare] Session ${code} rejected`);
    });

    socket.on("webrtc:offer", ({ code, offer }) => {
        code = String(code || "").trim();

        const session = sessions.get(code);

        if (!session || !session.accepted) {
            return;
        }

        if (socket.id !== session.viewerSocketId) {
            return;
        }

        safeEmit(session.hostSocketId, "webrtc:offer", {
            offer
        });
    });

    socket.on("webrtc:answer", ({ code, answer }) => {
        code = String(code || "").trim();

        const session = sessions.get(code);

        if (!session || !session.accepted) {
            return;
        }

        if (socket.id !== session.hostSocketId) {
            return;
        }

        safeEmit(session.viewerSocketId, "webrtc:answer", {
            answer
        });
    });

    socket.on("webrtc:ice-candidate", ({ code, candidate }) => {
        code = String(code || "").trim();

        const session = sessions.get(code);

        if (!session || !session.accepted) {
            return;
        }

        let target = null;

        if (socket.id === session.hostSocketId) {
            target = session.viewerSocketId;
        } else if (socket.id === session.viewerSocketId) {
            target = session.hostSocketId;
        }

        if (!target) {
            return;
        }

        safeEmit(target, "webrtc:ice-candidate", {
            candidate
        });
    });

    socket.on("session:disconnect", ({ code }) => {
        code = String(code || "").trim();

        closeSession(code, socket.id);
    });

    socket.on("disconnect", (reason) => {
        const code = socket.data.sessionCode;

        if (code) {
            closeSession(code, socket.id);
        }

        console.log("[SPNShare] Disconnected:", socket.id, reason);
    });
});

setInterval(() => {
    const now = Date.now();
    const maxSessionAge = 1000 * 60 * 60 * 6;

    for (const [code, session] of sessions.entries()) {
        if (now - session.createdAt > maxSessionAge) {
            io.to(code).emit("session:closed", {
                message: "The session expired."
            });

            sessions.delete(code);
            console.log(`[SPNShare] Expired session deleted: ${code}`);
        }
    }
}, 1000 * 60 * 10);

server.listen(PORT, "0.0.0.0", () => {
    console.log(`[SPNShare] Signaling server running on port ${PORT}`);
});
