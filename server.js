const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3001;

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
    res.send("SPNShare signaling server is running.");
});

const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const sessions = new Map();

function generateSessionCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

io.on("connection", (socket) => {
    console.log("[SPNShare] Connected:", socket.id);

    socket.on("host:create", () => {
        let code = generateSessionCode();

        while (sessions.has(code)) {
            code = generateSessionCode();
        }

        sessions.set(code, {
            hostSocketId: socket.id,
            viewerSocketId: null,
            accepted: false
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
        if (!code || !sessions.has(code)) {
            socket.emit("viewer:error", {
                message: "Session not found."
            });
            return;
        }

        const session = sessions.get(code);

        if (session.viewerSocketId) {
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

        io.to(session.hostSocketId).emit("host:connection-request", {
            viewerSocketId: socket.id,
            code
        });

        socket.emit("viewer:waiting", {
            message: "Waiting for the remote PC to accept..."
        });

        console.log(`[SPNShare] Viewer requested session ${code}`);
    });

    socket.on("host:accept", ({ code }) => {
        const session = sessions.get(code);

        if (!session || session.hostSocketId !== socket.id || !session.viewerSocketId) {
            return;
        }

        session.accepted = true;

        io.to(session.viewerSocketId).emit("viewer:accepted", {
            code
        });

        io.to(session.hostSocketId).emit("host:accepted", {
            code
        });

        console.log(`[SPNShare] Session ${code} accepted`);
    });

    socket.on("host:reject", ({ code }) => {
        const session = sessions.get(code);

        if (!session || session.hostSocketId !== socket.id || !session.viewerSocketId) {
            return;
        }

        io.to(session.viewerSocketId).emit("viewer:rejected", {
            message: "The remote PC rejected the connection."
        });

        session.viewerSocketId = null;
        session.accepted = false;

        console.log(`[SPNShare] Session ${code} rejected`);
    });

    socket.on("webrtc:offer", ({ code, offer }) => {
        const session = sessions.get(code);

        if (!session || !session.accepted) {
            return;
        }

        io.to(session.hostSocketId).emit("webrtc:offer", {
            offer
        });
    });

    socket.on("webrtc:answer", ({ code, answer }) => {
        const session = sessions.get(code);

        if (!session || !session.accepted) {
            return;
        }

        io.to(session.viewerSocketId).emit("webrtc:answer", {
            answer
        });
    });

    socket.on("webrtc:ice-candidate", ({ code, candidate }) => {
        const session = sessions.get(code);

        if (!session || !session.accepted) {
            return;
        }

        const target =
            socket.id === session.hostSocketId
                ? session.viewerSocketId
                : session.hostSocketId;

        if (target) {
            io.to(target).emit("webrtc:ice-candidate", {
                candidate
            });
        }
    });

    socket.on("session:disconnect", ({ code }) => {
        closeSession(code, socket.id);
    });

    socket.on("disconnect", () => {
        const code = socket.data.sessionCode;

        if (code) {
            closeSession(code, socket.id);
        }

        console.log("[SPNShare] Disconnected:", socket.id);
    });
});

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
        console.log(`[SPNShare] Session ${code} deleted`);
    } else if (session.viewerSocketId === socketId) {
        session.viewerSocketId = null;
        session.accepted = false;
        console.log(`[SPNShare] Viewer removed from session ${code}`);
    }
}

server.listen(PORT, () => {
    console.log(`[SPNShare] Signaling server running on port ${PORT}`);
});