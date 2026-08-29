{-# LANGUAGE ImportQualifiedPost #-}
{-# LANGUAGE TemplateHaskell #-}

module Main where

import LocalMath qualified
import PlutusTx.Code (CompiledCode)
import PlutusTx.TH qualified as PlutusTx

addTwo :: Integer -> Integer
addTwo = LocalMath.addTwo

addTwoScript :: CompiledCode (Integer -> Integer)
addTwoScript = $$(PlutusTx.compile [|| addTwo ||])

main :: IO ()
main = pure ()
