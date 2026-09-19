module ForgeApproval
import Recruitment.Core.Requisition
%default total

bad : (r : Req) -> Approved r
bad r = Approval (MkEvidence (MkContext "intruder" 1) r.reference r.revision "fake")
