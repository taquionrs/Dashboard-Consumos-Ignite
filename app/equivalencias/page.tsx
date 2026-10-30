import { headers } from "next/headers";
import EquivalenciasView from "../components/EquivalenciasView";
import { readSession } from "@/lib/access";

export default function EquivalenciasPage() {
  return <EquivalenciasView session={readSession(headers())} />;
}
