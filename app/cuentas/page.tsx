import { headers } from "next/headers";
import CuentasView from "../components/CuentasView";
import { readSession } from "@/lib/access";

export default function CuentasPage() {
  return <CuentasView session={readSession(headers())} />;
}
