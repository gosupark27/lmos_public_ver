import { createFileRoute } from "@tanstack/react-router";
import { HandshakeApp } from "@/components/handshake/play";

export const Route = createFileRoute("/")({ component: HandshakeApp });
