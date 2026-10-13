import { headers } from "next/headers";
import UsuariosView from "../components/UsuariosView";
import { readSession } from "@/lib/access";

export default function UsuariosPage() {
  return <UsuariosView session={readSession(headers())} />;
}
