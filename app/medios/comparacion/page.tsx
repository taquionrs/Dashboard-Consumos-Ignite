import { headers } from "next/headers";
import ComparacionView from "../../components/ComparacionView";
import { readSession } from "@/lib/access";

export default function ComparacionPage() {
  return <ComparacionView session={readSession(headers())} />;
}
