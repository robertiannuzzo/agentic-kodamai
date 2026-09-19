module ForgeScore
import Recruitment.Core.Score
%default total

bad : (a : Advert) -> Application a -> Score a
bad a app = Computed app (MkBreakdown 100 100 100 100)
